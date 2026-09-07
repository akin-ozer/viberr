# Pass 35 — questions for the owner

| id | asked | background | options | recommendation | answer |
|---|---|---|---|---|---|
| Q35-1 | answered | KNC-1 crossed Review→Merge (declared `approval`, "approved by a human") by the operator alone, because the controller set `stage-transitions: direct` and the engine consults the boundary only under `recommend` (F35-2). The controller told you supervised autonomy means you approve each merge transition; it does not. | (a) A declared `approval` boundary always needs a human: `direct` covers `auto` boundaries only, `approval` routes to a recommendation, `human` refuses. (b) Keep grant-overrides-boundary, and make every surface (policy page, project.md `by:`, board, tool replies) say "the operator crosses this itself while stage-transitions is direct". | (a): a boundary the project author wrote is the contract every human reads; a grant should not silently void it. | **(a) Boundary always wins** (owner, 14:10Z) → implement: `approval` always routes to a human recommendation, `human` refuses, `direct` covers `auto` only. |
| Q35-2 | answered | The owner's Codex account hit its usage limit at 14:03Z after ~9 delivery runs; 9 tasks carry "Work stalled" packets (retry on Claude / send back later / redirect / hold). | wait for the window; retry on Claude; connect another credential | wait (keeps the astra rule) | **Wait for the window** (owner, 14:10Z). Stalled packets are resolved with "send back to continue" once Codex reopens (~15:18Z). |
| Q35-3 | answered | RBAC probes need sessions for the 4 synthetic users the controller created. | owner signs in ×4; observer signs in; skip | owner signs in | **Observer signs in** (owner: "this is test data"); the temp passwords stay in the dock transcript only, never in this ledger. |
| Q35-4 | answered | Collision and post-review divergence need fixtures viberr's agents cannot create; the owner's rule was never to push to k9s-clone by hand. | both fixtures via API; collision only; none | both | **Yes, both** (owner, 14:31Z): one stray one-file commit + PR on a `knc-3x` branch; one empty commit on an approved branch; labelled observer fixtures. |
| Q35-5 | answered | $40 after 2 hours, 80% coordination. | keep going; trim the board | keep going | **Keep going, and file the inefficiency as a product gap** (owner, 14:31Z) → G35-5. |
| Q35-6 | answered | Codex window really reopens at 18:18Z (UTC container clock), 3.5 h away; all no-Codex probes done. | switch delivery to Claude; wait; another credential | switch | **Switch delivery to Claude now** (owner, 14:47Z): deployments → claude/opus/high via the controller, stalled packets resolved with retry_other_backend, the astra rule recorded as broken by quota. |

## Plan-stage questions (from PLAN-DRAFT-2, F35-7/F35-8) — pending
- Q35-7 (F35-7) Propagating template grants REPLACES a deployed copy's grant lists (a grant a project admin added locally is dropped and the reply says so) vs a union that never removes. Recommendation: replace, the copy is meant to mirror the template.
- Q35-8 (F35-7) "Use the template's grants" on the project Agents page for a PROJECT admin, or org-admin only (modal + controller arg)? Recommendation: org admin only; the project admin sees the divergence marker and asks.
- Q35-9 (F35-8) A `scheduled` operator run lifts a hold set after the schedule was created? Recommendation: yes, a person created the schedule.
- Q35-10 (F35-8) The refused arm of the collision ceremony leaves the same packet-less blocked shape as a hold, so a later Run operator lifts it and relies on the operator reopening a packet. Recommendation: accept; exempting collision blocks by a marker adds a second shape for one case.
- Q35-11 (F35-7) The org modal toast carries an em dash (`GA:426`); rewrite under the copy rule in this pass? Recommendation: yes, it is one string.

## Plan-stage questions from the later findings — pending
- Q35-12 (F35-11) A PR a person closed without merging: refuse every new PR for that branch until the recovery packet is answered (ruling 160), or open the fresh PR and shout? Recommendation: refuse; a closure is a decision, and the packet already exists for it.
- Q35-13 (G35-6) Let a person discard a never-pushed branch even after the agent reported (the revision is retired with it, ruling 161)? Recommendation: yes; the review pins nothing that never left the workspace.
- Q35-14 (F35-9) Make the read-only CLIs (`keys status`, `backup`) snapshot the store automatically when a live writer holds the root, and rewrite the runbook to "copy first, never a second connection" (ruling 158)? Recommendation: yes; it is the only reader shape that survived today.
- Q35-15 (G35-5) Which coordination-cost remedies go in this pass: (a) a reserved operator lane outside the run cap so decisions never queue behind builds; (b) the transition turn writes the acceptance recommendation itself, removing the second operator turn per approval; (c) both. Recommendation: (c). Evidence: 14 operator turns queued behind 6 builds at 19:05Z; every approval cost two turns at ~$0.30.
- Q35-16 (U35-7) A restart-interrupted run: show it as "interrupted by a restart" and keep it out of the error count, with never-started queued runs out of the success denominator? Recommendation: yes.
- Q35-17 (F35-12) Should the operator be refused the transition INTO the Merge stage while the PR conflicts with the base (the task stays at the work stage where the conflict packet lives), or only the recommendation? Recommendation: both; Merge means "mergeable".
- Q35-18 (G35-5 addendum) Move the base refresh from every operator turn to acceptance time (one refresh + gate + merge in the accept ceremony) and stop operators refreshing at Merge? Recommendation: yes; the conflict cascade above is the cost of refreshing early.
- Q35-19 (F35-13) When a rework changes the revision at or past the review stage, return the task to the review stage automatically (ruling 163), or keep the human stage move as the only path and just name it? Recommendation: automatic; the packet the operator wrote today shows what "just name it" costs.

## Plan-gate answers (owner, 2026-09-06 22:05Z–22:12Z)
- Q35-17 + Q35-18 + Q35-19 (Merge-stage integrity): ALL THREE. A revision that changes after a verdict returns the task to the review stage automatically; the operator may not move into Merge or recommend acceptance while the PR conflicts (one gate function read everywhere); the base refresh happens once at acceptance time. Rulings 162, 163, G35-5 addendum (d)(e).
- Q35-15 (coordination cost): LANE + FOLD. Reserved operator lane outside the run cap, and the transition turn writes the acceptance recommendation itself.
- Q35-12 + Q35-13 (branches): BOTH RULES. Ruling 160 (no new PR after a human closure until the packet is answered) and ruling 161 (a never-pushed revision may be discarded; the discard retires it).
- Q35-7 + Q35-8 (F35-7): REPLACE the copy's grants; ORG ADMINS ONLY may propagate; project admins see the divergence marker.
- Q35-9 + Q35-10 (F35-8): a SCHEDULED operator run lifts a later hold; refused collision ceremonies keep the SAME packet-less blocked shape (a later Run operator lifts it; the operator reopens a packet if needed).
- Q35-14 (F35-9): COPY THE FILE FIRST. `keys status` and `backup` copy projection.sqlite plus its WAL and open the copy whenever a live writer holds the root; the runbook says never open the live database from another program, copy it first. Ruling 158.
- Q35-16 (U35-7): INTERRUPTED STATE, HONEST COUNTS.
- Q35-11 (em dash in the org modal toast): rewrite under the copy rule (no question needed).
- Scope: EVERYTHING, ONE PR on akin-ozer/viberr, based on the observation branch.

## Closing answers (owner, 2026-09-07)
- **e2e gate:** run it with the live container stopped. Done: Docker started 17:13Z, `viberr-app-1` stopped at 17:14Z (zero operator turns fired in the six minutes it was up, so no spend), `npm run e2e` in its own `viberr-e2e` compose project: **70 passed**.
- **Ruling 160's door on an operator-less project:** LEAVE AS IT IS. The exits stay reopening the pull request on GitHub or archiving the task. No confirmed-Deliver ceremony, no auto-answer on reopen. The open issue in FIX-SUMMARY.md stands as recorded behaviour, not a defect.
- **Insights historical rows:** NO BACKFILL. The owner is wiping the old data root ("we are still preprod"), so the `usage_final` default of 0 on existing rows needs no one-off update, and terminal estimates stay named beside the token totals rather than inside them.
- **The k9c board:** PARK AND CLEAN UP. Done, see NOTES.
