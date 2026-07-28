# Pass 15 — Consolidated findings ledger (2026-07-28)

Sources: live use (USECASES.md, NOTES.md), 10 code maps + CRITIC (docs/), product-intent doc audit.
Status legend: OPEN → DONE (commit) / DEFER (why) / RULED (owner decision recorded).
Severity: C=critical H=high M=medium L=low D=doc/copy.

## A. Live-found (F15-01..19) — all repro'd on the fresh compose instance

| id | sev | status | finding (detail in NOTES.md) |
|----|-----|--------|------------------------------|
| F15-01 | M | OPEN | Credential card: `assumed` scopes dodge both the `unverified` branch and proven chips → green "Every provable scope verified" with ZERO proven scopes; attach-at-project-creation never ran the write probes ([credential-card.tsx:77-121](app/features/github/credential-card.tsx:77)) |
| F15-02 | M | DONE 7d602ea | Project GitHub panel "Synced: not yet synced with GitHub" renders while PR/merge state is clearly live; "Update status" gives zero feedback (14ms no-op POST). Sync-freshness copy + action need truth |
| F15-03 | L | OPEN | Watcher logs "reconciled removed directory" for a project dir at creation (transient race; verify no state-loss path) |
| F15-04 | M(UX) | OPEN | Create-project returns to home grid instead of opening the new project |
| F15-05 | H | OPEN | Profile DETAIL panel auto-shows `reviewer-expertise` + wrong default caps for NEW profiles (display layer; stored grants honest — matrix disagrees with detail panel). Org "1 context resource" count same bug |
| F15-06 | H | OPEN | Same panel shows verdict caps ("Approve the review", "Request changes") as ACTS DIRECTLY for any new profile; capability matrix correctly shows Not granted |
| F15-07 | — | n/a | (withdrawn — KB chips were in a collapsed group, working as designed) |
| F15-08 | L | OPEN | Agent-log timestamps render UTC while timeline renders local (same page, 3h apart) |
| F15-09 | L | OPEN | Board card duplicates the "agent working" badge (chip + footer) |
| F15-10 | M | DONE 7d602ea (R15-1 confirm dialog) | Accept completion merges a PR with NO confirmation dialog (owner Q — see D) |
| F15-11 | M | DONE 7d602ea | Done/archived tasks keep live controls: active "Accept completion", Run/Run-operator buttons, schedule form |
| F15-12 | M | DONE 7d602ea (R15-3) | Contributor task-owner sees Apply/Dismiss on a STAGE rec; Apply 403s silently (server refuses `approve-transition`; UI swallows). Gate the buttons per-kind or extend owner authority (owner Q) |
| F15-13 | L | DONE 7d602ea (all 3 writers) | Out-of-band-merged PR: acceptance timeline claims "Merged PR #n into main" as the human's act |
| F15-14 | H | OPEN | Triage quality gate never fired on a textbook-vague goal; operator improvised scope and burned a 91-turn run. Tighten operator triage doctrine + consider a server-side nudge (dialog promises flagging) |
| F15-15 | C | DONE 7d602ea | Pre-existing remote task-key branch: push fails non-FF → copy blames credential → PR opened on stale junk → **reviewer approves from LOCAL branch, never the PR head** → acceptance would merge junk. Fix cluster: distinct non-FF detection + honest copy; never open/keep PR whose head ≠ delivered commit; bind review/acceptance to PR head SHA |
| F15-16 | L | OPEN | Board search placeholder promises "agents"; agent names don't match; global-⌘K mock promise still dangling (owner Q3, product-intent) |
| F15-17 | H | DONE 7d602ea (R15-2) | Delivery binds to structural final-adjacent stage (`reviewStageIdOf`): inserting QA after Review silently moves push+PR to QA; entering literal "Review" delivers nothing, no event. Needs ruling + a visible signal either way |
| F15-18 | M | OPEN | 375px viewport keeps fixed sidebar; content ~140px. D-29 "reflow" unmet |
| F15-19 | H | DONE 7d602ea (R15-1, all 3 writers) | Human acceptance succeeds with NO verdict on the delivered revision (chip "awaiting verdict"), async with zero feedback (~30s), then merges. Verdict requirement only binds operator-direct path + blockReason wedges. Owner Q on required gate |

Facts (not defects) worth keeping: Developer-Claude pushes its branch at creation, Codex doesn't (parity nuance; made F15-17 visible). Operator honored backward-move-without-note by asking via one @tag (ruling working). Archive cancelled packets+schedules provably (RV-03 live-verified). Full-autonomy self-accept requires the explicit grant and discloses correctly; merge stays human. Strict preset lives in workflow rules, not operator caps.

## B. Code-map suspects promoted to fix items

### Delivery / GitHub (pairs with F15-15/17)
| id | sev | status | item |
|----|-----|--------|------|
| B-GH1 | H | DONE 7d602ea | Non-FF push: detect distinctly, stop blaming credentials, offer recovery (rename/reset-branch packet) — github-credentials §5 + F15-15 |
| B-GH2 | M | OPEN | `failureMessage` still names dropped `workflow` scope (connections.server.ts:190-195) |
| B-GH3 | M | OPEN | Rotate/Attach rebinds to DEFAULT connection regardless of repo owner (github-actions.server.ts:110-119) — multi-connection footgun |
| B-GH4 | L | DONE 7d602ea | `github.pr.opened` audit row on every reuse (pr-open.server.ts:369-377) |
| B-GH5 | M | OPEN | Reconciler: unbounded parallel task reconcile per tick; no concurrency cap/backoff |
| B-GH6 | L | OPEN | Required-scope set defined twice (pat-store vs connections) — unify |
| B-GH7 | M | OPEN | Connection `valid` state trusted forever; no periodic revalidation of org connections |
| B-GH8 | L | OPEN | `revalidateProjectCredential` resolves write-scope violations on read-only "assumed" evidence (pat-validator.server.ts:406-523) |

### Workflow core / acceptance (pairs with F15-19)
| id | sev | status | item |
|----|-----|--------|------|
| B-WF1 | H | DONE 7d602ea (direct + packet paths) | Direct `acceptCompletion` lacks in-lock re-check after merge await (P14-GV-05 fixed only the packet path) — workflow-core §3 |
| B-WF2 | H | OPEN | `block_on_policy` writes `validation:"failing"` directly (single-writer violation; next derive reverts it) + hold packets never clear/un-hold (no affordance) |
| B-WF3 | M | OPEN | Scheduled runs fire as bare `trigger:"manual"` — note/identity never reach the operator directive |
| B-WF4 | M | DONE 7d602ea | Terminal/review stage resolved 3 ways (schedule positional, task-actions structural, operatorAccept positional) — one resolver |
| B-WF5 | L | OPEN | `fireDueSchedules` LIKE-scan on JSON status; stale header comment describing the pre-fix flow |
| B-WF6 | M | DONE 7d602ea (shared core, 3 writers) | `operatorAcceptCompletion` re-implements Done inline (drift-prone mirror of acceptCompletion) — share one path (operator map §4) |
| B-WF7 | L | OPEN | `reorderTask` can 403 after passing visible gate (reorder-board vs approve-transition split — currently same tier, add test tying them) |

### Operator (map §Suspects)
| id | sev | status | item |
|----|-----|--------|------|
| B-OP1 | H | OPEN | Stale live-store operator doctrine: seeded-before-rewrite stores run dead-tool SOP; no hash-refresh for UNEDITED shipped definitions |
| B-OP2 | H | OPEN | Newest-wins pending queue can swallow a queued `humanComment` trigger (human's question dropped) — preserve/merge human triggers |
| B-OP3 | M | OPEN | Stranded-resume never fires cross-boot (`stageAtStart: null` on recovery paths) |
| B-OP4 | L | OPEN | Codex `input` fallback packet options thin (request_edit/redirect only) |
| B-OP5 | L | OPEN | `operatorBackendFor` duplicates deployment-backend resolution |

### Agents / runtimes
| id | sev | status | item |
|----|-----|--------|------|
| B-AG1 | H | OPEN | Save-time `normalizeDeliveryGrants` still escalates explicit headline `off`→`direct` silently, no audit (RV-01's save-side sibling; capabilities.ts:244-253) |
| B-AG2 | M | OPEN | `@claude`/`@codex` handle engages first-listed specialist of that backend (arbitrary); tighten match or refuse ambiguous |
| B-AG3 | L | OPEN | Evidence-only Codex envelope: schema without prompt instruction |
| B-AG4 | M | OPEN | Undeployed-profile runs keep permissive collab defaults (comment/ask/evidence on) — align with conservative tool posture (owner Q?) |
| B-AG5 | L | OPEN | Stale `ResolvedSpecialist.definition` comment claims removed override exists |
| B-AG6 | M | OPEN | Denylist marker-string coupling across files (CAP_DENY_RULES ↔ withheld detectors) — add the tying test |

### Foundation / UI / interpretation
| id | sev | status | item |
|----|-----|--------|------|
| B-FD1 | H | OPEN | Boot-time single-writer lock on the data root (dual-writer incident twice; foundation map) |
| B-FD2 | M | OPEN | First-name mention fan-out ("@arda" notifies every Arda; no dedup/priority) |
| B-FD3 | M | RULED? | WI-13 vs FR4: board/task readable app-wide while review/activity 403 "must not learn project exists" — coherence ruling needed (critic + ui-routes §7) |
| B-FD4 | M | OPEN | Home Settings tiles link every member to admin-403 routes; storeRoot path leaks to non-admins (ui-routes §1/§4) |
| B-FD5 | M | OPEN | Board "waiting on you" union (UI-48) missing on Home + bell (acceptance-without-packet invisible off-board); `input_required` matches no filter |
| B-FD6 | L | OPEN | Notification rows without task target are dead clicks |
| B-FD7 | M | OPEN | Run pipeline: interrupt/finalize race (finalize overwrites `interrupted`); silent DB line-loss divergence |
| B-FD8 | M | OPEN | Guardrails: toolkit reports "posted" for dropped/deduped comments (model believes narration exists); @mentions past brevity-trim never notify; silent drops lack audit parity |
| B-FD9 | L | OPEN | Timeline compaction deletes human prose from canonical task.md with only a count marker; agent floods never compact |
| B-FD10 | L | OPEN | Audit rows double as idempotency keys but expire at 90d (reprocessing hazard, guardrails map) |

## C. Doc fixes (product-intent map)
| id | status | item |
|----|--------|------|
| C-D1 | OPEN | `planning/README.md:14-17` falsely claims design/prd.md is in sync — freeze-label or re-sync (owner Q) |
| C-D2 | OPEN | `ux-design-specification.md:940` contradicts its own :870 amendment (review-first mobile) |
| C-D3 | OPEN | `architecture.md:431` still instructs OAuth-first build (historical; mark it) |
| C-D4 | OPEN | Promote 3 post-pass-14 rulings (pr-diverged recovery packet, minimum scopes, proven-only chips) into `docs/architecture/decisions.md` (+FR where fitting) |
| C-D5 | OPEN | PRD frontmatter cites `_bmad-output` inputs that no longer exist |

## D. Owner rulings (2026-07-28, recorded from live Q&A)
- **R15-1 (F15-19/F15-10)**: Human acceptance REQUIRES a healthy verdict on the delivered revision; audited Force-accept is the only bypass; every accept shows a confirm dialog stating what merges + any missing signals.
- **R15-2 (F15-17)**: Delivery (push + open review PR) is an OPERATOR decision, not a fixed stage side-effect. The operator weighs the task's remaining stages and delivers when it judges it plausible; when unsure it opens a decision packet asking whether to push/open the PR; it may OFFER early delivery when later stages (e.g. QA) aren't needed for this task. (Server still executes the mechanics; agents still never push/PR themselves.)
- **R15-3 (F15-12)**: A task owner may apply/dismiss ANY operator recommendation on their own task, including stage transitions — the click is the authorization (FR37 spirit).
- **R15-4 (B-FD3)**: Projects are MEMBERS-ONLY: non-members cannot open boards/tasks (404-style); WI-13 secrecy wins; FR4's app-wide commenting applies within projects the user can see.
- **R15-5 (F15-16)**: Build the global ⌘K palette (tasks/branches/agents/projects, visibility-scoped, quick-jump).
- **R15-6**: Delete-remote-branch-on-merge as a per-project setting (default on).
- **R15-7 (B-AG4)**: Ghost/undeployed-profile runs are fully conservative — no comments/ask-human/evidence, matching the tool posture.
- **R15-8 (C-D1)**: Re-sync `design/prd.md` with all canon amendments (both copies maintained; README sentence becomes true again).

## D2. Original question list (for the record)
1. **F15-19/F15-10**: Should human acceptance require a healthy verdict on the delivered revision (with force-accept as the only bypass), and should accept/merge get a confirm step? (Recommended: yes+yes.)
2. **F15-17**: With post-review stages (QA), where do delivery (push+PR) and the review queue bind — the stage named/role'd "review" or the structural Done-adjacent stage? (Recommended: bind to the review ROLE stage; QA inherits acceptance only.)
3. **F15-12**: Should a task OWNER (contributor) be allowed to Apply operator TRANSITION recommendations on their own task (widening R14-2/R6-2), or keep maintainer+ and hide the buttons?
4. **Q-search**: Global ⌘K palette (mock promise) — build, or amend copy to "board filter"? (F15-16)
5. **B-FD3**: App-wide task readability vs WI-13 non-member 403s — which is intended?
6. **F15-04**: Land on the new project after creation? (Recommended: yes.)
7. **Post-merge branch cleanup**: merged task branches accumulate (vib-1..4,7,9 remain) — auto-delete option?
8. **B-AG4**: Undeployed-profile runs: keep permissive collab defaults or go conservative?
