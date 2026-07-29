# Pass 15 — Consolidated findings ledger (2026-07-28)

Sources: live use (USECASES.md, NOTES.md), 10 code maps + CRITIC (docs/), product-intent doc audit.
Status legend: OPEN → DONE (commit) / DEFER (why) / RULED (owner decision recorded).
Severity: C=critical H=high M=medium L=low D=doc/copy.

## A. Live-found (F15-01..19, F15-21) — all repro'd on the fresh compose instance

| id | sev | status | finding (detail in NOTES.md) |
|----|-----|--------|------------------------------|
| F15-01 | M | DONE 5e8b000 (card) + e1cb8bb (creation now probes, handback applied) | Credential card: `assumed` scopes dodge both the `unverified` branch and proven chips → green "Every provable scope verified" with ZERO proven scopes; attach-at-project-creation never ran the write probes ([credential-card.tsx:77-121](app/features/github/credential-card.tsx:77)) |
| F15-02 | M | DONE 7d602ea | Project GitHub panel "Synced: not yet synced with GitHub" renders while PR/merge state is clearly live; "Update status" gives zero feedback (14ms no-op POST). Sync-freshness copy + action need truth |
| F15-03 | L | DONE 9827ab7 (traced benign first — no state-loss path — then the false reconcile removed) | `fs.watch` emits `rename` on directory CREATION too and `rebuildDir` never checks existence, so a new project dir runs the removal sweep and logs it. NO state-loss path (250 ms debounce lands after creation's own rebuild; atomic task writes are never transiently absent) — false log + wasted per-project reproject. Patch in handbacks/S4-github.md |
| F15-04 | M(UX) | DONE 5e8b000 | Create-project returns to home grid instead of opening the new project |
| F15-05 | H | DONE 5e8b000 | Profile DETAIL panel auto-shows `reviewer-expertise` + wrong default caps for NEW profiles (display layer; stored grants honest — matrix disagrees with detail panel). Org "1 context resource" count same bug |
| F15-06 | H | DONE 5e8b000 | Same panel shows verdict caps ("Approve the review", "Request changes") as ACTS DIRECTLY for any new profile; capability matrix correctly shows Not granted |
| F15-07 | — | n/a | (withdrawn — KB chips were in a collapsed group, working as designed) |
| F15-08 | L | DONE 5e8b000 + e440fe9 (coverage was vacuous in CI) | Agent-log timestamps render UTC while timeline renders local (same page, 3h apart) |
| F15-09 | L | DONE 5e8b000 | Board card duplicates the "agent working" badge (chip + footer) |
| F15-10 | M | DONE 7d602ea (R15-1 confirm dialog) | Accept completion merges a PR with NO confirmation dialog (owner Q — see D) |
| F15-11 | M | DONE 7d602ea | Done/archived tasks keep live controls: active "Accept completion", Run/Run-operator buttons, schedule form |
| F15-12 | M | DONE 7d602ea (R15-3) | Contributor task-owner sees Apply/Dismiss on a STAGE rec; Apply 403s silently (server refuses `approve-transition`; UI swallows). Gate the buttons per-kind or extend owner authority (owner Q) |
| F15-13 | L | DONE 7d602ea (all 3 writers) | Out-of-band-merged PR: acceptance timeline claims "Merged PR #n into main" as the human's act |
| F15-14 | H | DONE 5e8b000 + e440fe9 (gate added to the goal-updated turn too) | Triage quality gate never fired on a textbook-vague goal; operator improvised scope and burned a 91-turn run. Tighten operator triage doctrine + consider a server-side nudge (dialog promises flagging) |
| F15-15 | C | DONE 7d602ea | Pre-existing remote task-key branch: push fails non-FF → copy blames credential → PR opened on stale junk → **reviewer approves from LOCAL branch, never the PR head** → acceptance would merge junk. Fix cluster: distinct non-FF detection + honest copy; never open/keep PR whose head ≠ delivered commit; bind review/acceptance to PR head SHA |
| F15-16 | L | DONE 5e8b000 (R15-5 palette + honest board-filter copy) | Board search placeholder promises "agents"; agent names don't match; global-⌘K mock promise still dangling (owner Q3, product-intent) |
| F15-17 | H | DONE 7d602ea (R15-2) | Delivery binds to structural final-adjacent stage (`reviewStageIdOf`): inserting QA after Review silently moves push+PR to QA; entering literal "Review" delivers nothing, no event. Needs ruling + a visible signal either way |
| F15-18 | M | DONE 5e8b000 | 375px viewport keeps fixed sidebar; content ~140px. D-29 "reflow" unmet |
| F15-19 | H | DONE 7d602ea (R15-1, all 3 writers) | Human acceptance succeeds with NO verdict on the delivered revision (chip "awaiting verdict"), async with zero feedback (~30s), then merges. Verdict requirement only binds operator-direct path + blockReason wedges. Owner Q on required gate |
| F15-21 | M | DONE 5e8b000 (ledgered late — see §F) | Stage editor: "Add stage" committed on the *click*, minting a workflow stage literally named "New stage". A stray press wrote a **governed edge in the transition chain** that then had to be removed by hand. Observed live in UC-19. Fixed name-first: the name IS the request, and an empty one is refused ([settings-actions.server.ts:414](app/features/project-settings/settings-actions.server.ts:414)) |

Facts (not defects) worth keeping: Developer-Claude pushes its branch at creation, Codex doesn't (parity nuance; made F15-17 visible). Operator honored backward-move-without-note by asking via one @tag (ruling working). Archive cancelled packets+schedules provably (RV-03 live-verified). Full-autonomy self-accept requires the explicit grant and discloses correctly; merge stays human. Strict preset lives in workflow rules, not operator caps.

## B. Code-map suspects promoted to fix items

### Delivery / GitHub (pairs with F15-15/17)
| id | sev | status | item |
|----|-----|--------|------|
| B-GH1 | H | DONE 7d602ea | Non-FF push: detect distinctly, stop blaming credentials, offer recovery (rename/reset-branch packet) — github-credentials §5 + F15-15 |
| B-GH2 | M | DONE (S4) | `failureMessage` still names dropped `workflow` scope (connections.server.ts:190-195) |
| B-GH3 | M | DONE (S4) | Rotate/Attach rebinds to DEFAULT connection regardless of repo owner (github-actions.server.ts:110-119) — multi-connection footgun |
| B-GH4 | L | DONE 7d602ea | `github.pr.opened` audit row on every reuse (pr-open.server.ts:369-377) |
| B-GH5 | M | DONE (S4) | Reconciler: unbounded parallel task reconcile per tick; no concurrency cap/backoff |
| B-GH6 | L | DONE (S4) | Required-scope set defined twice (pat-store vs connections) — unify |
| B-GH7 | M | DONE 5e8b000 + e1cb8bb (store-files caller upgraded too) | Connection `valid` state trusted forever; no periodic revalidation of org connections |
| B-GH8 | L | DONE 9827ab7 | `revalidateProjectCredential` resolves write-scope violations on read-only "assumed" evidence (pat-validator.server.ts:406-523) |

### Workflow core / acceptance (pairs with F15-19)
| id | sev | status | item |
|----|-----|--------|------|
| B-WF1 | H | DONE 7d602ea (direct + packet paths) | Direct `acceptCompletion` lacks in-lock re-check after merge await (P14-GV-05 fixed only the packet path) — workflow-core §3 |
| B-WF2 | H | DONE 9827ab7 | `block_on_policy` writes `validation:"failing"` directly (single-writer violation; next derive reverts it) + hold packets never clear/un-hold (no affordance) |
| B-WF3 | M | DONE 5e8b000 | Scheduled runs fire as bare `trigger:"manual"` — note/identity never reach the operator directive |
| B-WF4 | M | DONE 7d602ea | Terminal/review stage resolved 3 ways (schedule positional, task-actions structural, operatorAccept positional) — one resolver |
| B-WF5 | L | DONE 5e8b000 | `fireDueSchedules` LIKE-scan on JSON status; stale header comment describing the pre-fix flow |
| B-WF6 | M | DONE 7d602ea (shared core, 3 writers) | `operatorAcceptCompletion` re-implements Done inline (drift-prone mirror of acceptCompletion) — share one path (operator map §4) |
| B-WF7 | L | DONE 9827ab7 (tying test) | `reorderTask` can 403 after passing visible gate (reorder-board vs approve-transition split — currently same tier, add test tying them) |

### Operator (map §Suspects)
| id | sev | status | item |
|----|-----|--------|------|
| B-OP1 | H | DONE 5e8b000 | Stale live-store operator doctrine: seeded-before-rewrite stores run dead-tool SOP; no hash-refresh for UNEDITED shipped definitions |
| B-OP2 | H | DONE 5e8b000 + e440fe9 (packet-storm clause) | Newest-wins pending queue can swallow a queued `humanComment` trigger (human's question dropped) — preserve/merge human triggers |
| B-OP3 | M | DONE 5e8b000 | Stranded-resume never fires cross-boot (`stageAtStart: null` on recovery paths) |
| B-OP4 | L | DONE 5e8b000 | Codex `input` fallback packet options thin (request_edit/redirect only) |
| B-OP5 | L | DONE 9827ab7 | `operatorBackendFor` duplicates deployment-backend resolution |

### Agents / runtimes
| id | sev | status | item |
|----|-----|--------|------|
| B-AG1 | H | DONE 5e8b000 + e440fe9 (the notice reaches the admin) | Save-time `normalizeDeliveryGrants` still escalates explicit headline `off`→`direct` silently, no audit (RV-01's save-side sibling; capabilities.ts:244-253) |
| B-AG2 | M | DONE 5e8b000 + e440fe9 (refusal ships WITH the reply) | `@claude`/`@codex` handle engages first-listed specialist of that backend (arbitrary); tighten match or refuse ambiguous |
| B-AG3 | L | DONE 5e8b000 | Evidence-only Codex envelope: schema without prompt instruction |
| B-AG4 | M | DONE under R15-7 (owner ruled conservative; run side 5e8b000, completion side e440fe9) | Undeployed-profile runs keep permissive collab defaults (comment/ask/evidence on) |
| B-AG5 | L | DONE 5e8b000 | Stale `ResolvedSpecialist.definition` comment claims removed override exists |
| B-AG6 | M | DONE 5e8b000 | Denylist marker-string coupling across files (CAP_DENY_RULES ↔ withheld detectors) — add the tying test |

### Foundation / UI / interpretation
| id | sev | status | item |
|----|-----|--------|------|
| B-FD1 | H | DONE 5e8b000 + e440fe9 (SIGTERM release, eager arming, bootId identity) + **8a95d92 (the one that made it real: node as pid 1)** | Boot-time single-writer lock on the data root (dual-writer incident twice; foundation map). The in-process half passed every unit test while the container still leaked the lock on `docker compose stop` — `npm run start` made npm pid 1, so SIGTERM never reached the lock holder |
| B-FD2 | M | DONE 5e8b000 + e440fe9 (machine callers disclose too) | First-name mention fan-out ("@arda" notifies every Arda; no dedup/priority) |
| B-FD3 | M | DONE under R15-4 (members-only supersedes the FR4-vs-WI-13 tension) | WI-13 vs FR4: board/task readable app-wide while review/activity 403 "must not learn project exists" — coherence ruling needed (critic + ui-routes §7) |
| B-FD4 | M | DONE 5e8b000 | Home Settings tiles link every member to admin-403 routes; storeRoot path leaks to non-admins (ui-routes §1/§4) |
| B-FD5 | M | DONE 5e8b000 + e440fe9 (honors the R15-1 gate) | Board "waiting on you" union (UI-48) missing on Home + bell (acceptance-without-packet invisible off-board); `input_required` matches no filter |
| B-FD6 | L | DONE 5e8b000 | Notification rows without task target are dead clicks |
| B-FD7 | M | DONE 5e8b000 | Run pipeline: interrupt/finalize race (finalize overwrites `interrupted`); silent DB line-loss divergence |
| B-FD8 | M | DONE 5e8b000 | Guardrails: toolkit reports "posted" for dropped/deduped comments (model believes narration exists); @mentions past brevity-trim never notify; silent drops lack audit parity |
| B-FD9 | L | DONE 5e8b000 | Timeline compaction deletes human prose from canonical task.md with only a count marker; agent floods never compact |
| B-FD10 | L | DONE 5e8b000 | Audit rows double as idempotency keys but expire at 90d (reprocessing hazard, guardrails map) |

## C. Doc fixes (product-intent map)
| id | status | item |
|----|--------|------|
| C-D1 | DONE 6d1dc92 | `planning/README.md:14-17` falsely claims design/prd.md is in sync — freeze-label or re-sync (owner Q) |
| C-D2 | DONE c778b97 | `ux-design-specification.md:940` contradicts its own :870 amendment (review-first mobile) |
| C-D3 | DONE c778b97 | `architecture.md:431` still instructs OAuth-first build (historical; mark it) |
| C-D4 | DONE c778b97 (decisions.md rulings 17-27) | Promote 3 post-pass-14 rulings (pr-diverged recovery packet, minimum scopes, proven-only chips) into `docs/architecture/decisions.md` (+FR where fitting) |
| C-D5 | DONE 6d1dc92 | PRD frontmatter cites `_bmad-output` inputs that no longer exist |

## D. Owner rulings (2026-07-28, recorded from live Q&A)
- **R15-1 (F15-19/F15-10)**: Human acceptance REQUIRES a healthy verdict on the delivered revision; audited Force-accept is the only bypass; every accept shows a confirm dialog stating what merges + any missing signals.
- **R15-2 (F15-17)**: Delivery (push + open review PR) is an OPERATOR decision, not a fixed stage side-effect. The operator weighs the task's remaining stages and delivers when it judges it plausible; when unsure it opens a decision packet asking whether to push/open the PR; it may OFFER early delivery when later stages (e.g. QA) aren't needed for this task. (Server still executes the mechanics; agents still never push/PR themselves.)
- **R15-3 (F15-12)**: A task owner may apply/dismiss ANY operator recommendation on their own task, including stage transitions — the click is the authorization (FR37 spirit).
- **R15-4 (B-FD3)**: Projects are MEMBERS-ONLY: non-members cannot open boards/tasks (404-style); WI-13 secrecy wins; FR4's app-wide commenting applies within projects the user can see.
- **R15-5 (F15-16)**: Build the global ⌘K palette (tasks/branches/agents/projects, visibility-scoped, quick-jump).
- **R15-6**: Delete-remote-branch-on-merge as a per-project setting (default on). — DONE (S4): `delete-branch-after-merge` project.md guardrail (absence = ON), toggle on Settings → Repository & credentials (`edit-policy` tier), enforced inside `mergeTaskPr`'s success path so all three acceptance writers get it; refusals stay refusals and land as plain-words notes.
- **R15-7 (B-AG4)**: Ghost/undeployed-profile runs are fully conservative — no comments/ask-human/evidence, matching the tool posture.
- **R15-8 (C-D1)**: Re-sync `design/prd.md` with all canon amendments (both copies maintained; README sentence becomes true again).

### D1b. Second ruling round (2026-07-29) — the five design calls handed back at close-out
- **R15-9** (the USECASES open question): an ABSENT `deliver-review-pr` grant resolves from the project's own governance, not a constant. The capability postdates R15-2, so "absent" is the normal state on every pre-existing project, and a flat `direct` made two projects with identical governance behave differently by creation date. The preset is never stored — it is a creation-time shaping input — so the rule reads its EFFECT off the workflow graph (`humanGatesPreWorkAdvance`). **Deriving beats a stored field precisely because it is already true of projects that predate the capability** (a new column would be absent on exactly the projects that need it — F15-20's shape). Gate and panel share `absentDeliverReviewPrMode`, so they cannot drift. Explicit grants always win. — DONE, canary-proven at both layers.
- **R15-10** (UX-ASSESSMENT Q1): the first empty board teaches, ONCE — entry column only, only at zero tasks, bare again as soon as one exists. Narrows P13-D-34 rather than reversing it. — DONE.
- **R15-11** (Q2): the Review queue stays a triage list; rows gain a named action ("Review ›" + `aria-label`). Deliberately not "Accept" — acceptance is verdict-gated and may refuse, and a surface must not name an outcome it cannot promise (the F15-22 rule). — DONE, and the queue is already in the WCAG sweep.
- **R15-12** (Q4): unenforced capability lines are COLLAPSED under "Advisory only · N", never hidden. Hiding was the alternative and was rejected — an omission the reader cannot see is worse than an awkward truth, and "role-irrelevant" is a judgment the code should not make about policy. — DONE; added the agents surface to the WCAG sweep, which had never covered it.
- **R15-13** (Q3): settings headings name their own scope — "Instance settings" and "<project> · settings". The five wayfinding strings pointing at the old title were updated with it. — DONE, pinned by a jsdom test and a live e2e across both pages.

## D2. Original question list (for the record)
1. **F15-19/F15-10**: Should human acceptance require a healthy verdict on the delivered revision (with force-accept as the only bypass), and should accept/merge get a confirm step? (Recommended: yes+yes.)
2. **F15-17**: With post-review stages (QA), where do delivery (push+PR) and the review queue bind — the stage named/role'd "review" or the structural Done-adjacent stage? (Recommended: bind to the review ROLE stage; QA inherits acceptance only.)
3. **F15-12**: Should a task OWNER (contributor) be allowed to Apply operator TRANSITION recommendations on their own task (widening R14-2/R6-2), or keep maintainer+ and hide the buttons?
4. **Q-search**: Global ⌘K palette (mock promise) — build, or amend copy to "board filter"? (F15-16)
5. **B-FD3**: App-wide task readability vs WI-13 non-member 403s — which is intended?
6. **F15-04**: Land on the new project after creation? (Recommended: yes.)
7. **Post-merge branch cleanup**: merged task branches accumulate (vib-1..4,7,9 remain) — auto-delete option?
8. **B-AG4**: Undeployed-profile runs: keep permissive collab defaults or go conservative?

## D3. Found while live-proving my own fixes

| id | sev | status | finding |
|----|-----|--------|---------|
| F15-20 | MED | DONE 04ca24e | `deliver-review-pr` postdates every pre-R15-2 operator deployment; the runtime gate reads an absent grant as `direct`, so delivery worked while the Agents panel — which renders only persisted grants — showed no row for it. A capability governing real behavior was invisible AND uneditable. Materialized in `effectiveProfileView` at the mode the runtime applies, never overriding an explicit one. Canary-proven, verified live on the strict project |
| F15-22 | L(D) | DONE 9888063 (ledgered late — see §F) | The not-at-the-boundary acceptance refusal ended with "or ask an admin to force-accept it", but the DG-2 override is surfaced only for a **wedged** acceptance (unrecordable verdict / stale blocked packet). A task that merely has stages left to cross is not wedged, so the copy sent an admin hunting for a button that is not there. Same class as the R15-1 refusal work: a refusal must not name an escape hatch this surface does not offer |
| F15-23 | L(D) | DONE 6620e4e (ledgered late — see §F) | Accept-confirm dialog on a no-delivery task (VAL-2): the body correctly adapted — "No linked pull request — the task closes without a merge" with an "Accept → Done" action — while the **footer** still read "Merging is one-way … the merge are recorded". The dialog adapted its facts but not its fine print |

## E. Known environmental flake (not a product defect)

`app/server/files/file-watch.service.server.test.ts` failed twice across ~8 full-suite runs with
`EMFILE: too many open files`, always under load (docker container + several Chromium instances +
parallel vitest workers in one session). The file passes alone, and two consecutive full runs
immediately afterwards were clean at **2419/2419**. macOS per-process descriptor pressure, not a
watcher leak — recorded here so a future pass recognizes it instead of chasing it. If it ever
fails on an idle machine, THAT is a real leak and worth the hunt.

## F. Ledger integrity audit (2026-07-29, after the branch was already "done")

The pass-15 close-out ran a **ledger → diff** audit (for each row id, `git diff main..HEAD | grep`,
hand-check every zero). That direction proves *no row lies about being fixed*. It cannot catch the
opposite failure, so this audit ran the other direction: **diff → ledger** — for every non-test file
changed on the branch, does any ledger row cite a commit that touched it?

Method (zsh caveat worth keeping: `for c in $commits` does **not** word-split an unquoted string in
zsh the way bash does — the first run of this audit silently reported everything as unclaimed):

```
for f in $(git diff --name-only main..HEAD -- app/ | grep -v '\.test\.'); do
  claimed=0
  for c in ${(f)"$(git log --format=%h main..HEAD -- $f)"}; do
    grep -q "$c" FINDINGS.md && claimed=1
  done
  [ $claimed -eq 0 ] && echo "UNCLAIMED: $f"
done
```

Then: validate every hash cited in this file resolves to a commit **on this branch**, and list the
branch's code commits that no row cites at all.

**What it found — six defects in the evidence trail, zero in the product:**

| # | drift | correction |
|---|-------|------------|
| 1 | F15-01 cited `9827ab7` for the creation-probe half; it landed in `e1cb8bb` | citation fixed |
| 2 | B-GH7 cited `9827ab7` for the store-files caller; it landed in `e1cb8bb` | citation fixed |
| 3 | B-FD1 cited only the in-process SIGTERM work — **not `8a95d92`, the pid-1 fix that made release actually happen in the container** | citation + the reason it matters |
| 4 | F15-20 said "DONE (this pass)" with no hash | cites `04ca24e` |
| 5 | The stray-press "New stage" defect was found live (UC-19), fixed in `5e8b000`, and **never entered as a row** | ledgered as F15-21 |
| 6 | Two post-fix live copy defects were fixed (`9888063`, `6620e4e`) and recorded only in `UX-ASSESSMENT.md`'s prose table, not in the ledger | ledgered as F15-22 / F15-23 |

**The pattern**: every drift is in the last six commits. Up to `9827ab7` the loop was
find → ledger → fix → cite. After that it became find → fix → write it up *somewhere else*
(a shots commit message, the UX assessment). The ledger stayed *true* — nothing in it was false —
but it stopped being *complete*, which is the failure mode a ledger→diff audit is structurally
blind to. **Run both directions, and run them last.**

Also closed here: the one live-phase question left hanging with a ⚠ and never answered —
`search-mcp` (registry row with `up: false`) is still passed to the SDK and reports `status: failed`
in-run. That is **the design, not a defect**: pass-14 ruled LV-09b as honesty-not-removal ("a probe
can be stale, and the CLI may connect where the probe could not"). Verified the disclosure half
survived this pass's capability rewrite —
[specialist-run.server.ts:1148](app/server/tasks/specialist-run.server.ts:1148) still emits
"# MCP servers that may be unavailable … the last connection check failed", and
[specialist-mcp.server.ts:107](app/server/tasks/specialist-mcp.server.ts:107) still distinguishes
that from a grant reaching no server at all. USECASES UC-23/24/25 updated.

**Third thing the audit found — a coverage gap on an explicitly-requested behavior.** The directive
named "correct skill loading (**not unrelated skills**)". UC-23's row claimed "Run mounts ONLY
granted skills ✅", but every piece of evidence behind it was *positive* — a granted skill visibly
changed the agent's behavior. Nothing anywhere proved the **negative**, and a run log cannot: the
persona travels as `systemPrompt` and never lands in the run's jsonl. The behavior was correct
(`buildSpecialistPersona` iterates the profile's declared list, never the store; `Skill` is in
`BASE_DENIED_BUILTINS`), so this was a *proof* gap, not a defect — but a "load everything in the
store" regression would have shipped silently. Now pinned and canary-proven; see USECASES UC-23.

**The generalizable lesson**: a ✅ that rests only on positive evidence is half a proof. "X reaches
the run" and "only X reaches the run" are different claims, and the second is the one a capability
system actually promises.

## G. Second ruling round — live verification (2026-07-29, rebuilt container)

Image rebuilt and confirmed identical to source (`ls build/server/assets | sort | md5` matches
inside the container), then every ruling driven through the running app.

| ruling | live evidence |
|---|---|
| **R15-9** | DevOps Skills (strict, no stored grant) — the delivery capability now renders under **Recommends**. Viberr (balanced, no stored grant) — still **Acts directly**. Same absent grant, opposite answers, decided by the project's governance rather than its creation date |
| **R15-10** | DevOps Skills board: entry column reads "No tasks yet — create one to start the flow", the other four bare — one message. Viberr board (9 tasks): every empty column bare, P13-D-34 intact |
| **R15-11** | Proven in a real browser on the e2e fixture, which has queue rows: `.rq-go` reads "Review", is `aria-hidden`, the row's `aria-label` is `Review VIB-142: …`, and clicking still lands on the task. **Not** proven on the docker instance — its review queues were empty, and the honest reason is worth keeping: Viberr's queue binds to the STRUCTURAL review stage, which on that board is **QA**, not the stage named "Review" (F15-17's resolver doing its job). Walking a task there was blocked by an open scope packet, and bypassing governance to manufacture a row would have proven nothing |
| **R15-12** | Developer profile: `<details>` reads "Advisory only · 2 lines the runtime does not read", closed by default; expanding shows both lines with their modes intact ("Run unit & integration validation (acts directly)"). Agents surface added to the WCAG sweep and passes in both themes |
| **R15-13** | `/org/settings` h1 = "Instance settings" (exactly one h1); `/projects/viberr/settings` h1 = "Viberr · settings" |

**And the container caught a defect in my own R15-10 that every unit test had passed.**
`boardTotal` was `allTasks.length`, which counts ARCHIVED tasks. DevOps Skills holds exactly one
task, archived, sitting in the entry column — so the board rendered zero cards in five columns while
the code believed it had a task, and the one board in the instance that most needed the teaching
line was the only board that could never show it. `matchesBoardFilter` hides archived tasks under
every filter except "Archived", so they are invisible by design; the count had to be of LIVE tasks,
matching the R14-3 doctrine the file's own neighbouring comment already states. Fixed, tested
against exactly that shape (`total: 1, boardTotal: 0` still teaches), canary-proven.

**That is the third time this pass** that a defect survived a green suite and died on the running
app — after the pid-1 signal bug and F15-20. The pattern in all three: the test asserted the rule I
had in mind, and the instance held a state I had not imagined (npm as pid 1; a capability with no
row; a board whose only task is archived). **Tests check the rule; only the instance checks the
assumption.**

**The unexplained single-test failure now has a name (2026-07-29).** It first showed up in a
combined gate run right after a docker rebuild, with only the summary captured — recorded then as
unexplained rather than filed under a flake it merely resembled. It recurred later, and running the
suite in a loop while capturing the FAIL line identified it:

`app/server/files/kb-watch.service.server.test.ts > startKbWatcher — live watcher > re-indexes an
'on change' KB when a store file changes (debounced)`

Same family as the EMFILE flake above and **already known**: the test's own comment records that two
separate work streams hit it independently, and a prior pass bounded it with a 30 s deadline. It
still fails occasionally in a full parallel run. Its subject is a real OS filesystem event —
FSEvents delivery + a 250 ms debounce + a re-index — and macOS coalesces FSEvents under the load of
~206 test files churning temp directories. Measured rate here: **2 failures in 12 full-suite runs**,
never in isolation (that file passed 5/5 alone, and the suite is clean at 2445/2445 on a quiet
machine).

Not fixed, and deliberately not re-bounded: raising a deadline that is already 30 s trades a real
signal for a longer wait. The fix that would actually work is to stop depending on real FSEvents in
this test (inject the watcher event instead), which is a refactor of someone else's test and not
this turn's job. **Named here so the next pass recognises it in one grep instead of re-deriving
it** — and so a future failure in a DIFFERENT file is not waved through as "probably the watcher".
