# Pass 35 — Viberr builds a k9s clone (observation summary)

Owner goal: drive viberr's controller to build a k9s clone in `akin-ozer/k9s-clone` through
viberr's own machinery, exercise the whole surface, and file only the findings that make
viberr lie, lose work, block a path with no way out, or make a person do something absurd.

## What happened (short)

- 13:08Z The controller (Opus 1M, high) got one goal message on the Home dock. In one turn
  (55 tool calls, 12 min, $2.88) it decided the product (`k9c`: Go, tview/tcell, client-go,
  cobra, goreleaser), wrote 3 KBs and 3 skills, created the project with 7 custom stages and an
  approval boundary before Merge, rewrote/created 8 agent templates, deployed 9 agents with the
  requested models (delivery gpt-6-astra medium, operator/reviewers opus high), and defined 4
  chained goals (29 links). It reported its own refusals and deviations honestly, including the
  two tools it lacks (schedules, template model/effort).
- 13:17-13:43Z Cycle 1 (KNC-1, the ADR): empty-repo bootstrap, Codex delivery, PR #1,
  request_changes, rework, two approvals, the operator walked every stage, and the human
  accepted from the recommendation: PR merged from viberr, branch deleted, goal advanced.
- 13:43-14:03Z Cycle 2 (KNC-5, the Go scaffold): the Codex agent found no Go/make/python in
  the image and installed them into its workspace; PR #2; approve; the human merged out of band
  with gh and viberr reconciled the divergence and accepted afterwards.
- 13:56Z Turn 2 raised parallelism to 27 tasks, created 4 users, one MCP server, enabled the
  browser capability, and loosened chain waits. 14:03Z the owner's Codex quota ran out; 22
  packets opened (recovery, conflict, scope). Every packet kind except discard_branch was then
  exercised by hand: retry/hold/redirect/custom/edit_goal/archive/archive+delete/collision.
- 14:23-15:14Z Deliberate rejection (PR #5 closed → archive+delete), force-accept (KNC-10),
  PR adoption (KNC-8, #3 → #6), the planted branch collision (KNC-30, cleared and re-delivered
  as #11), RBAC across four roles plus a non-member (88 probes), archive/restore, goal ops,
  schedules, guardrails, secondary assignment, task-scoped dock.
- 14:47Z Codex reopens only at 18:18Z; the owner moved delivery to Claude opus. 15:29Z the
  Claude five-hour window ran out too (all runs refused, 21 packets); the pass paused until the
  window reset at 18:30Z, then every packet was resolved by hand.
- 18:40Z The container died with SIGBUS (exit 135) one second after my in-container read-only
  probe of the store, the form the runbook prescribes as safe (F35-9). Boot recovery finalized
  23 runs and re-fired 23 operator turns; the operators found the partial workspaces themselves.
  The interrupted runs count as "errors" with a pseudo-user "restart" (U35-7). Every reader was
  moved to a snapshot copy afterwards.
- 18:50-19:47Z The remaining probes: the discard_branch fixture on knc-21 produced a collision
  packet without the discard kind, and a direct request for it was refused because the agent's
  "Done" report had already registered a revision (G35-6); the post-review drift fixture on
  knc-28 was disclosed by the operator as a costed packet before Merge (R17-1 holds), though
  the task page said nothing for ten minutes; a PR closed by the owner under a running delivery
  was silently replaced by a fresh PR (F35-11) while the same closure with no delivery in flight
  produced the divergence note in ten seconds; KNC-9's agent committed a task attachment inside
  the clone because the prompt names the attachments folder by a store-relative path (F35-10).
  Cycles 4-8 merged (viberr accept, gh merge + divergence accept, one stale-page 409 retried);
  second rejection archived.
- 20:38-21:56Z The API key ran out (auth packets; the owner swapped the key and clicked the
  re-run options), GitHub and TLS wobbled twice (honest packets each time), and the merge
  cascade set in: with ~10 PRs touching README/Makefile/.gitignore, every acceptance made the
  others conflict, and every conflict rework at Merge stranded its task where no reviewer is
  eligible (F35-13); thirteen conflict packets and four manual stage moves later, 15 PRs were
  merged and the rest left in the loop for the owner. KNC-27 proved the browser capability
  end to end (a real headless capture of GitHub's 404 for the private repo, posted as an
  attachment, with an honest question packet). 30 PRs opened, 15 merged, 2 rejected.

## Findings (see FINDINGS.md)

F35-1 live output-token accounting ~500x low · F35-2 the `approval` boundary does not hold
under `stage-transitions: direct` (owner ruling: boundary always wins) · F35-3 stale goal-link
wait cannot be cleared · F35-4 dock route leaks a hidden project's name · F35-5 silent refusal
of a human @mention of an ineligible agent · F35-6 edit_goal draft lost on reload, no-op save
reports "Goal updated" · F35-7 template grants never reach deployed copies, controller reports
success · F35-8 hold_runtime_debug readiness never lifts ("blocked" + "agent working") ·
F35-9 a second read-only store connection inside the container preceded the server's SIGBUS
(the runbook calls that form safe) · F35-10 the attachments prompt path lands inside the
delivered repository and was pushed to GitHub · F35-11 a PR the owner closed unmerged is
silently replaced by a fresh PR when a delivery races the reconciler · F35-12 a conflicting
PR is recommended and offered for acceptance, then refused · F35-13 a rework at Merge has no
route back to review (the human stage picker is the hidden way out).
Gaps: G35-1 no controller schedule tool · G35-2 no template model/effort · G35-3 no GitHub
handle without OAuth · G35-4 dispatch into a known-exhausted backend, resetsAt null ·
G35-5 coordination cost (55-80% of spend, two operator turns per approval, 14 operator turns
queued behind 6 builds under one global cap) · G35-6 discard_branch unreachable once the
agent has reported.
Coherence: U35-1 `&amp;` names · U35-2 mobile reading order · U35-3 forced-acceptance audit
under-records · U35-4 HTTP send door vs disabled composer · U35-5 review queue sees only the
stage before Done · U35-7 restart-interrupted runs shown as "continuity error" · U35-8
archive+deleteBranch deleted a foreign remote head while the audit named the local sha ·
U35-11 a local TLS failure is attributed to the provider.

## Owner decisions

Q35-1 boundary always wins · Q35-2 wait for the Codex window (then Q35-6: switch delivery to
Claude) · Q35-3 observer signs in the synthetic users · Q35-4 both hand fixtures · Q35-5 keep
going, file the cost gap. Pending at the plan gate: Q35-7 to Q35-16 (QUESTIONS.md).

## Record checks

Every event in NOTES.md was checked against task.md, project.md, goal files, GitHub and the
audit table; a sweep at 14:44Z found 30/30 content hashes and stages consistent and a
re-scan changed nothing. COVERAGE.md is the per-surface checklist with evidence.

## Still open at the time of writing

The F35-9 reproduction (deferred to a scratch root in the fix phase; the server never went idle),
then the plan gate (PLAN.md, 22 entries, rulings 151-163, questions Q35-7 to Q35-19) and the
implementation. Final numbers: 628 runs, $469.60, 87% completion, 35% coordination by cost
(70% of runs by count), 15 merged PRs, clone builds and runs from main.
