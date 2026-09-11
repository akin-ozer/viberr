# Pass 36 — summary (observation closed 18:45Z; fix phase in progress)

## What happened

Viberr built the first slices of a Headlamp clone in `akin-ozer/headlamp-clone` through its
own controller, operator and specialists, with the observer driving only the controller dock,
the task pages and GitHub (fixtures and merges). Model rule: controller on Claude `opus`/high;
operator, Server Developer and Frontend Developer on Codex `gpt-5.6-luna`/max; the Code
Reviewer started on luna/max and was moved to Claude `opus`/high at 14:57Z (owner Q36-3) after
F36-1 and F36-3 made every sandboxed Codex run fail.

| item | count at 16:42Z |
|---|---|
| tasks created | 16 (HLC-1..16; 5 by the controller's goals directly, the rest by chained-goal advancement, `retry_link`, or the observer) |
| merged PRs, all delivered by Viberr's agents | 10 — #1 (HLC-6 LICENSE + CONTRIBUTING), #6 (HLC-7 docs/architecture, adopted after the rejection of #3), #4 (HLC-1 scaffold), #8 (HLC-10 fake-kube harness, after two request-changes rounds), #9 (HLC-11 kubeconfig + cluster endpoints), #10 (HLC-13 kinds registry + generic resource API, after a Secret-leak request-changes), #11 (HLC-12 YAML route), #14 (HLC-15 search API), #12 (HLC-3 logs API, four review rounds, two conflict packets), #13 (HLC-14 web app shell, three rounds; merged out of band with `gh` and then accepted through Viberr on the already-merged path) |
| PRs rejected on purpose | #2 (HLC-8, archive + delete branch), #3 (HLC-7, closed → recovery packet → adoption of hand PR #6) |
| PRs left to diverge after review | #3/#6 lineage: observer commit 64daccb on hlc-7 at Merge Approval (F36-7) |
| observer fixtures on GitHub | PR #5 (squat on `hlc-10`), PR #7 (stray PR on `hlc-10-0c88`, closed by the collision resolution) |
| agent runs | 144+ ($21.57 reported by cost-reporting runs; Codex runs report no cost) |
| review rounds | HLC-10: 3; HLC-11: 1; HLC-13: 2; HLC-12: 1; HLC-15: 1; HLC-14: 3; HLC-3: 4 — every request-changes named a real defect (strict TS gap, fixture fidelity, a Secret value leak, a navigation throw, log-stream semantics); ~$27 of Claude review spend across 15 rounds |

The clone at this point: a Node/TypeScript monorepo (server, shared, web), CI, docs, a fake
Kubernetes API harness with fixtures, kubeconfig loading with a client pool, the kinds
registry and generic resource API (list/get with Secret masking), the YAML route, the search
API, `npm run start:fake`, and (in review) the container-logs API and the React app shell
with the kinds sidebar, cluster/namespace/search top bar and typed API client — the Frontend
Developer drove Viberr's browser capability against its own `start:fake` server and attached
the screenshot. Resource tables, detail views with logs/events, namespace switching in the
UI and the YAML tab are the rest of goals 1–5; the pass stops at the cycle target, so the
"really runs" bar for the UI is NOT met by the merged code yet, while the server half
(cluster connection, lists, YAML, search, logs) is. What is proven end to end: the delivery pipeline, the review gate,
the acceptance ceremony and the goal chain.

## What Viberr did well (worth keeping)

- The acceptance ceremony: revision-bound verdicts, the accept dialog naming PR, branch
  refresh, revision and verdict, the merge as the one human act, the audit trail; every
  merged PR carries the exact reviewed head.
- Ruling 164 held everywhere it was tried: `resolve_remote_collision` closed the stray PR,
  replaced the branch, opened the real PR and lifted the block in one confirmation; the
  packet archive did exactly what its dialog said (except U36-1's restore promise).
- Honest refusals with reasons: stage-ineligible agents (form and mention), closed tasks on
  the page's own buttons, operator "Task is closed" copy, "Mention not started" notes.
- The goal chain: link advancement on ship, failed link on archive with a notification,
  `retry_link` and `skip_link` through the controller with the waits carried over.
- The rework loop: request-changes → Building → rework → re-delivery to the same PR → new
  work revision → verdict void → re-review, 6m28s wall clock per round.
- Files-are-truth: 13/13 task files matched their projections on every sweep (one transient
  mismatch during a write cleared on the next sweep).

## What is broken (FINDINGS.md has the rows; CODE-CHECKS.md the file:line evidence)

High: F36-1 (seccomp blocks every sandboxed Codex run), F36-3 (shared CODEX_HOME helper
race kills concurrent sandboxed runs), F36-5 (a shipped task keeps being coordinated and asks
humans for decisions). Medium-high: F36-6 (Viberr's own next-step card carries a failed
review across the approval boundary), F36-7 (post-review authored drift: silent, no
re-review path). Medium: F36-2 (SKILL.md body unvalidated), F36-4 (@operator on an archived
task), F36-8 (silent model fallback on backend retry), F36-9 (skill mount breaks the
project's own gate in the agent workspace). Plus 11 UX/coherence rows, 4 gaps, 1 doc row;
3 candidates refuted by code.

## Owner decisions (QUESTIONS.md)

Q36-1 seccomp unconfined; Q36-2 fixtures allowed; Q36-3 reviewers on Claude for the run;
Q36-4 no restricted PAT (scope violations not exercised); Q36-5 project-level required
reviewer rule; Q36-6 no recurrence; Q36-7 operator resources through the controller;
Q36-8 interrupt live runs at acceptance; Q36-9 ruling 163 extends to the PR head; Q36-10
picker eligibility before the click; Q36-11 per-run CODEX_HOME.

## Next

PLAN.md (rulings 177–183, six clusters, red-then-green tests, live checks) → fix branch
`pass36/headlamp-clone-fixes` → gates → PR → rebuild + live re-validation with the reviewer
back on luna/max → another model reviews.
