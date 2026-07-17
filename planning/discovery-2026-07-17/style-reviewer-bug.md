# Style Reviewer "0 direct · 0 recommend · 0 human" — root-cause investigation

Date: 2026-07-17 · Read-only investigation, no code changes.

## Symptom

On the Policy page (Agent capability panel) and the Agents page, the **Style Reviewer**
profile renders `0 direct · 0 recommend · 0 human`, while every other profile
(Operator, Developer, Reviewer, Docs Writer) shows nonzero counts. Live evidence proves
the profile FUNCTIONS: it was summoned as a reviewer, ran, and produced a
"validation healthy / PASS" verdict on a task.

## 1. Where the profile is defined + its stored capability policy

Style Reviewer is a **project-level deployment**, not an org template. There is no
`data/agents/profiles/style-reviewer.md` (that dir holds only developer/operator/reviewer).
It is stored inline in the project file:

`data/projects/viberr/project.md:161-181`
```yaml
- profileId: style-reviewer
  capabilities: []          # <-- EMPTY
  extras: []                # <-- EMPTY
  definition:
    kind: specialist
    name: Style Reviewer
    role: Docs style review
    ...
    stages: [review]
    resources: { skills: [docs-style], mcps: [], kb: [] }
```

Its stored capability policy is **genuinely empty** (`capabilities: []`, `extras: []`).

Compare the built-in **Reviewer** (`data/projects/viberr/project.md:98-122`) which stores
**11** capability grants (read-repo-diff, run-validation-suites, author-test-cases,
attach-evidence-references, post-quality-flags, comment-on-task all `direct`;
approve-review, request-changes `recommend`; merge-pull-request, transition-to-done,
commit-push-branch `human`).

## 2. Where the "N direct / N recommend / N human" counts come from

- Roster/count assembly: `app/features/agents/agents-query.server.ts`
  - `effectiveProfileView()` (lines 153-223) builds `actions` via
    `capabilitiesToActionLabels(effectiveGrants, deployment.extras)` (line 213).
  - `capabilitiesToActionLabels()` (lines 88-106) buckets each stored grant by mode:
    `direct`→direct, `recommend`→recommend, `human`|`off`→forbidden. With an empty
    `capabilities`+`extras`, all three buckets are `[]`.
- Render (Policy): `app/features/policy/policy-page.tsx:237-250` prints
  `{p.actions.direct.length} direct`, `{p.actions.recommend.length} recommend`,
  `{p.actions.forbidden.length} human`.
- Render (Agents): `app/features/agents/agents-page.tsx:334-335` (`CapColumn` per bucket).

Note on why **Reviewer shows 8 direct** (matching the report): for a specialist,
`effectiveProfileView` coerces every `recommend` grant to `direct` via
`coerceSpecialistCapabilityMode` (agents-query.server.ts:170-175, R7-5). So Reviewer's
6 stored-direct + 2 coerced-from-recommend = **8 direct · 0 recommend · 3 human**.
Style Reviewer has nothing to coerce, so **0 · 0 · 0**.

## 3. WHY Style Reviewer yields 0/0/0

The stored capability map is empty, so the counter — which is faithful — reports 0/0/0.
The emptiness is a direct consequence of how the profile was created.

Style Reviewer was created through the UI create-profile flow. The create path is
**safe-by-default**: `createModalGrants()` in
`app/features/agents/agent-profile-actions.server.ts:185-197` persists ONLY the modal
caps the form explicitly submitted, and deliberately seeds **nothing** for omitted caps
(see the block comment at lines 172-184: "a form that submitted 2 caps persisted ~12…
A capability the form omits now stays ABSENT — off, not direct"). The Style Reviewer
create submitted no capability toggles (a pure read-only reviewer), so
`createModalGrants({}) === []` and the deployment persisted `capabilities: []`.

By contrast the seed profiles (developer/reviewer/docs-writer) were authored in
demo-data with explicit capability lists — including the **decorative advisory rows**
(read-repo-diff, run-validation-suites, author-test-cases, attach-evidence-references,
post-quality-flags, comment-on-task). `capability-catalog.ts:37-47` documents that these
review-flavored ids have **ZERO runtime references** — they were pruned from the modal as
"fake toggles" and now only surface read-only in the matrix's "Other actions" group.
They are exactly what inflates Reviewer's counts to nonzero.

Why the profile still FUNCTIONS with an empty policy: a reviewer's real job is
**read the diff + reason + report a verdict to the operator**. None of the gated
specialist capabilities require a grant to do that — every gated cap
(create-task-branch, commit-push-branch, execute-code-or-write-repo, open-review-pr,
merge-pull-request, transition-to-done, change-project-policy) governs a **side-effectful
WRITE tool**. The specialist tool policy only *denies* a write tool when it sees an
explicit `off`/`human` grant; a read-only reviewer with no grants simply has no write
tools to gate and can still read + reply. So Style Reviewer works **legitimately**, not
incidentally.

## 4. Verdict: display bug, config bug, or neither?

**Neither a display-derivation bug nor a functional config bug — it is a cosmetic /
data-asymmetry issue.**

- NOT a display-derivation bug: `capabilitiesToActionLabels` correctly counts what is
  stored. Given `capabilities: []`, 0/0/0 is the accurate render.
- NOT a functional config bug: the profile holds zero *gated* capabilities, which is
  the correct policy for a read-only reviewer. It reviewed and returned a PASS verdict
  exactly as designed. Adding grants would not change its behavior (reviewing needs none).
- The real problem is **visual/semantic**: a legitimately zero-grant, read-only reviewer
  renders an alarming `0 · 0 · 0` that reads as "powerless/broken", specifically because
  the seed profiles carry decorative advisory capability rows that a UI-created profile
  (post safe-by-default fix) never receives. The panel has no affordance to distinguish
  "no gated capabilities (read-only reviewer)" from "misconfigured / empty".

### Recommended fix location

Primary (product-correct) — teach the count panel to render a "read-only · no gated
capabilities" affordance when all three buckets are empty, instead of a bare
`0 direct · 0 recommend · 0 human`:
- `app/features/policy/policy-page.tsx:237-250` (Policy Agent-capability panel)
- `app/features/agents/agents-page.tsx:334-335` (Agents card `CapColumn`s)

Optional data alternative — if the intent is parity with the built-in Reviewer's counts,
add capability grants to the `style-reviewer` deployment at
`data/projects/viberr/project.md:161-163`. Note this is purely cosmetic: the caps that
would raise the count (read-repo-diff, post-quality-flags, comment-on-task, …) are the
advisory "fake toggles" with zero runtime effect (`capability-catalog.ts:37-47`).

Do NOT "fix" `createModalGrants` to re-seed defaults — that seed-on-create behavior was
itself removed as a safe-by-default violation (agent-profile-actions.server.ts:172-184).

## 5. Re-verification: F7-REV3 ("Review passed" coexisting with validation=failing)

**Still prevented.** In `app/server/tasks/task-actions.server.ts`,
`recordReviewerVerdict` (lines 1480-1541) computes the event title FROM the resolved
validation, not the raw verdict:

- `validation = (verdict === "request_changes" || approveDidNotClear) ? "failing" : "healthy"` (line 1516-1517)
- `title = "Review passed"` is set ONLY in the `else` branch (lines 1527-1530), which is
  reachable exclusively when the verdict is `approve` AND `approveDidNotClear` is false —
  i.e. when `validation` has resolved to `"healthy"`.
- `parsed.frontmatter.validation = validation` (line 1531) writes that same resolved value.
- An approve landing on a still-failing task with no rework since the last rejection
  (`approveDidNotClear`, lines 1509-1515 via `hasReworkSinceLastRejection`) takes the
  middle branch → title `"Approval noted — rework still needed"`, validation stays
  `failing` (lines 1521-1526).

The design comment at lines 1490-1494 states the invariant explicitly: the event
"can never read 'Review passed / Validation: failing'". Confirmed by control flow — the
old F7-REV3 contradiction cannot recur.

## Key file:line citations

- `data/projects/viberr/project.md:161-163` — style-reviewer `capabilities: []` (root data state)
- `data/projects/viberr/project.md:98-122` — reviewer's 11 grants (contrast)
- `app/features/agents/agents-query.server.ts:88-106` — `capabilitiesToActionLabels` (bucket counter)
- `app/features/agents/agents-query.server.ts:170-175` — recommend→direct coercion (why Reviewer=8 direct)
- `app/features/agents/agent-profile-actions.server.ts:185-197` — `createModalGrants` (safe-by-default: empty on create)
- `app/features/agents/capability-catalog.ts:37-47` — advisory caps are "fake toggles", zero runtime refs
- `app/features/policy/policy-page.tsx:237-250` — Policy count render
- `app/features/agents/agents-page.tsx:334-335` — Agents count render
- `app/server/tasks/task-actions.server.ts:1516-1531` — F7-REV3 guard (title from resolved validation)
