# Pass 36 — summary (observation closed 18:45Z; fixes merged and re-validated live)

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

## The fix phase (18:05–20:xxZ)

Branch `pass36/headlamp-clone-fixes` → **PR #301** on akin-ozer/viberr. Rulings 177–183
written into decisions.md; every confirmed row of FINDINGS.md fixed; every fix carries a
test that was run red against the unfixed source (RED-PROOFS.md, ≈45 rows). Clusters 1, 2
and 6 were implemented in this session; clusters 3, 4, 5 and ruling 178 by four parallel
worktree agents, merged by hand (conflicts in run-service, compose, README, the controller
test file, controller-and-goals resolved and re-tested). Preprod rules held: no migrations,
no compatibility shims; the E4 `clearBody` flag, the in-checkout skill mount, the
`task.reviewer.assigned` audit name and the N20-17 disclosure are gone with their tests
rewritten.

Gates on the merged branch: lint clean, typecheck clean, `npm test` 362 files / 6464 tests
passed, `npm run e2e` 70 passed (production image, isolated stack). In-image canaries:
ruling 180 (SDK 0.3.261 init lists `viberr:<name>`, the model invokes it), ruling 181
(`CODEX_SQLITE_HOME` honoured, per-home `tmp/arg0`), ruling 182 (`codex sandbox` probe).

Live re-validation on the rebuilt image, same data root (REVALIDATION.md has the evidence
per row; NOTES.md the timestamps): the archived-task mention refused by name (1.1), the
force-accept that interrupted a live run and woke nothing (1.2), the restart note (1.4),
the budgeted poller skipping shipped tasks (1.3), the required-reviewer rule set by the
controller and shown on Policy/Settings (2.2), per-run `CODEX_HOME`s under concurrent runs
(3.1), the toolchain + sandbox probe on `instance_health` and the boot line (3.2), the
escaped SKILL.md body refused (4.1), operator KB grants through the controller (4.2), the
old → new reply (4.3), the picker's pre-click ineligibility (6.1), the suffixed-branch note
(U36-6) and the collision notification + wake (U36-7). The HLC-18 fixture cycle
("Add GET /api/version") covered the rest: see REVALIDATION.md rows 2.1, 2.3, 3.3, 5.1, 5.3,
6.2.

## The second day (2026-09-12): two live-found defects, one ruling reversed

Finishing the live checklist cost the pass its two hardest findings, and one of them
reversed a ruling written the day before.

**F36-10** — ruling 179's second half. Ruling 179 mints an external revision and sends the
task back for re-review, and then neither half of the rework could happen: the reviewer's
supporting checkout is a `--local` clone of the delivering tree, so the external commit was
present only as `origin/<branch>` while HEAD stood on the delivering head — its contract
said "PINNED to the delivered revision" and a sandboxed run could not move `.git` itself —
and the rework, started from the stale local head, had its delivery refused as
non-fast-forward. Fixed: a supporting checkout is detached at the active work revision (or
discloses why it could not), and a CLEAN task-branch checkout strictly behind
`origin/<branch>` is fast-forwarded; a diverged one is still left to a person, and the
refresh now says which of unpushed / in sync / ahead / diverged it is rather than calling
every task branch diverged.

**F36-11 → F36-12 → ruling 185** — the Codex sandbox, removed. With the network off the CLI
installs a seccomp filter that refuses every socket syscall, `AF_UNIX` included; libuv's
synchronous spawn needs a socketpair, so `spawnSync`/`execSync` report `EPERM` *after the
child has already run* and `npm ci` dies on esbuild's postinstall. No confined Codex run
could run a gate. Ruling 184 disclosed it (and the reviewer's next verdict said, in its own
words, that the environment limit "was not used as the content finding") — but it still
recorded `request-changes`, because an evidence-bound reviewer cannot approve a gate it
never ran, and the operator sent the deliverer back around. Rather than keep managing the
sandbox's limits the owner removed it (Q36-14): **ruling 185 — every Codex run is
`danger-full-access`**, the mode resolver, the probe, the refusal, the per-run sandbox row
and `compose.yml`'s `seccomp=unconfined` are gone, and a withheld repo-write grant is
ADVISORY on Codex, rendered as such on the editor, the matrix, the card and the run inputs.
That also retires F36-1's whole class: the container is back on Docker's own seccomp
profile. It was proven live end to end — HLC-19 ran through the controller in ~18 minutes
with no sandbox and no sandbox failure, and the same reviewer profile that could not
complete `npm ci` an hour earlier reported "The required `npm ci && npm run check` gate
passed at this exact SHA".

Two smaller ones rode along. **F36-13**: audit rows, notifications and retention pruning all
tie-broke on a random id, so two events in the same millisecond rendered in either order —
live, the activity feed put "cleared the required reviewers" above the "set" it followed,
and retention could delete the newer of two notifications; every such order now tie-breaks
on insertion order. **U36-13**: a pending schedule on a closed task now says it will be
skipped, beside the control that already says the task is closed.

Final gates: lint clean, typecheck clean, `npm test` 363 files / 6459 tests passed,
`npm run e2e` 70 passed. Twelve PRs merged in `headlamp-clone` across the pass.

## Next

Another model reviews PR #301.
