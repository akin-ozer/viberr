# Pass 31 — Improvement candidates & defects (living doc)

Statuses: OPEN (untriaged) / CONFIRMED (verified in code or live) / QUESTION (needs owner) / FIXED / REFUTED.
Sources: doc-agent sweeps (docs/00..06), live UI use, owner answers.

## A. Docs-vs-reality drift (low risk, high confusion cost)

- A1 FIXED (lint 0 errors, docs updated) `npm run lint` exits 1 on main (25 errors, 3 warnings) while docs/testing.md, docs/testing-quickstart.md, CONTRIBUTING.md:62, README.md:83 all promise "exit 0, no allowlist". Fix the errors or amend the docs (prefer: fix errors — the gate is the contract). [from 06]
- A2 FIXED (dated amendment) decisions.md ruling 35 records a stale PrAdoptionRefusal enum (`not_open` vs shipped `merged|closed`). Canon correction needed per ruling 44's own enforcement arm. [from 05]
- A3 FIXED (dated correction + fixture sweep) file-formats.md:230 documents an `accept: true` packet-option marker that packetOptionSchema does not have, despite a drift test on that file. [from 03]
- A4 FIXED (drift note +87 with absolute targets; routes.ts citation annotated historical) Stale spec citations: code cites §4.6/§5.11 of docs/build/specs/* deleted in c1acf2c; every ux-design-specification.md:NNN line cite is stale by +37; three 2026-08-06 "superseding" notes are themselves stale (spacing/elevation/radius shipped in pass 30). [from 04]
- A5 FIXED (Tailwind claims, counts recounted 32/18/25, real SSE names, new controller+goals section, agent_working declared in ux spec) architecture.md stale islands: Tailwind claimed twice, wrong route/feature counts, SSE examples never shipped; controller/chained goals (ruling 99, FR40/41) absent from BOTH ux spec and architecture.md; UX spec still teaches retired "Reassign" five times; derived state `agent_working` undeclared. [from 00/04]
- A6 FIXED docs/testing.md ends with two stray live-agent smoke artifacts; qa/pass2*-canary.md are agent droppings that read like QA docs. Clean up. [from 06]
- A7 FIXED (bracketed amendment pointers on FR5/11/14/27/39; PRD mirror kept byte-identical) Five FR head-sentences are now false without their amendments (FR5, FR11, FR14, FR27, FR39, +NFR1-5 markers) — rewrite bodies under ruling 44's spirit? QUESTION for owner. [from 00]

## B. Gate gaps (meta-tests that under-enforce their claims)

- B1 FIXED (radius scale locked totally, 2 off-scale literals snapped; spacing locked by de-facto step shape + documented; 5 canaries) app.css.test.ts locks only TYPE_SCALE; radius (6 tokens) + spacing snap live in comments; 47/226 border-radius declarations are literals. Lock radius+spacing scales like type. [from 06]
- B2 VERIFIED-OK (copy-ban coverage assertion pattern confirmed; retired-vocabulary asserts shipped artifacts) copy-ban's coverage assertion is great; consider replicating the pattern for retired-vocabulary (does it self-assert coverage?). VERIFY.

## C. Runtime/code sharp edges worth hardening

- C1 FIXED (outcome_key via typed RunPatch) `outcome_key` written via raw UPDATE at task-actions.server.ts:3049, bypassing run-store types (AgentRunRow/InsertRunInput/RunPatch don't know it). Move into the store module. [from 02]
- C2 FIXED (absentPolarityGate inside gate(); dedicated gates now thin fronts; 145 tests green) Absent-grant polarity three-way split: 4 caps absent-means-granted via dedicated gates; any NEW consumer of dispatch-agents that uses gate() silently breaks pre-rework projects. Consider a single polarity-aware resolver (kill the class). [from 02]
- C3 FIXED (env schema complete incl. idle-timeout via getEnv) 3 env vars used but missing from envSchema (VIBERR_GIT_CLONE_TIMEOUT_MS, VIBERR_TRANSCRIPT_RETENTION_DAYS, VIBERR_SESSION_HOME_RETENTION_DAYS); VIBERR_CLAUDE_IDLE_TIMEOUT_MS reads raw process.env. [from 02]
- C4 FIXED+VERIFIED LIVE (canary probe proved managedSettings.claudeMdExcludes silently dropped by SDK allowlist; excludes now written to workspace .claude/settings.json which the probe confirmed closes the ingress) managedSettings.claudeMdExcludes unverified: settingSources ['project'] may re-open repo CLAUDE.md as system-prompt-tier input on Claude leg (Codex leg closed deterministically). VERIFY + close. [from 02]
- C5 FIXED (last sibling: one malformed packet OPTION voided the whole open packet; now per-row tolerant with diagnostic; project/task arrays verified already per-row) Whole-array tolerant parse durable-loss class: recurring; grep remaining siblings (task + project schemas). [from 01]
- C6 VERIFIED ALREADY-SURFACED (budget-omitted KBs emit unresolved rows -> run_inputs.unresolvedResources -> run console lines; no code needed) Injection budgets shared across grant list and charged for headings — later KBs silently dropped into "omitted" marker; at minimum surface that in UI. [from 01]
- C7 FIXED (semantics documented at RunKind with index/CHECK dependencies named) `agent_runs.kind` naming trap (non-delivering developer stored as 'reviewer'); rename or document at the schema. [from 01]
- C8 FIXED (comment names AcceptConfirm; test file renamed pr-divergence-wake) Ghost names: pr-divergence-operator.server.ts exists only as a TEST file name; AcceptDisclosureProvider comment refers to never-shipped context (decision-packet.tsx:131); advanceGoalForTask survives only in DESIGN.md. Rename/clean. [from 03/05]
- C9 FIXED (constant extracted) `packet.kind === "Agent question"` load-bearing English string at task-actions.server.ts:6412. Type it.

- F6 FIXED (batch 1: resolve_remote_collision verb + coherence guard + ceremony) - was HIGH, safety/trust): Packet option kind mismatch — operator emitted `kind: discard_branch, deleteBranch: true` with option text "Delete the conflicting REMOTE branch (and its unrelated PR #232) and push this task's commit fresh", but discard_branch's real semantics (F20-6/R20-2, PacketDiscardConfirm in decision-packet.tsx) are: delete the LOCAL never-pushed workspace branch, destroying its commits; refuses only if branch exists on remote (ruling 17). Confirming the packet's stated promise would (with remote since deleted) silently destroy the delivered local commit e46279a and redeliver nothing — the opposite of the option text. Chain: (a) no packet kind / task action exists for the remote-collision remedy the system itself recommends in its policy note ("delete or rename the remote branch, then deliver again"); (b) open_decision_packet accepts arbitrary text on a kind with fixed semantics — no server-side coherence check; (c) ceremony copy contradicts option copy in the same dialog. FIX (implementation phase): add a first-class resolve-remote-collision action (ceremony: delete stale REMOTE branch + optionally close its unowned PR, then auto-redeliver), teach the operator toolkit to use it, and validate discard_branch option coherence at packet-open time.

- F11 FIXED (one-nudge stranded resume + record-the-hold instruction; loop verified re-armed pre-fix at 14 runs/$1.24) - was HIGH, cost/robustness): Operator self-react loop sustained by LLM wording variance. VIB-5 ("do nothing yet" goal): 8 consecutive operator runs, each starting ~25ms after the last (09:40:37→09:44:44), each posting a semantically-identical but differently-worded status comment; the byte-level no-progress compare (stripCcLine both sides) treats reworded text as progress, so each comment re-armed the next react until the 8-run stuck-loop guard posted its policy note. ~7-8 turns burned per run. Compounding: every run's comment claimed to BE "this scheduled operator run" while the actual schedule (due 09:46) had not fired — trigger metadata isn't surfaced to the operator, so it confabulated its trigger. FIX: (1) no-progress should compare canonical task-state (stage, packet, runs, recommendations, goal hash), not comment text; (2) operator's own status comment must not count as a react trigger; (3) pass the firing trigger kind into the operator prompt so it can't misattribute. TESTPLAN T19.

## D. Product/UX observations from live use (growing)

- D1 FIXED /insights page has no document title (F31-1).
- D2 FIXED Role-change toast uses first name only ("QA is now Contributor") — ambiguous among QA users; use full display name.
- D3 OPEN Agent resources page doesn't show a profile's capability template/modes at a glance (F31-5).
- D4 DECIDED-NO-CHANGE (investigated 2026-08-31): keep the full mirror. A blob:none partial clone would make later checkouts/log/diff operations lazily fetch blobs over the network MID-RUN (agents routinely run git show/diff/log in workspaces), turning a one-time visible wait into unpredictable stalls inside paid agent runs, and offline/degraded-GitHub behavior would regress. The existing mitigations already ship: cold-clone honesty label (R21-4/D1 pass 23) + live percentage streaming (F27-U1), and the mirror is per-project one-time. Revisit only if a customer-scale repo makes first-task latency a real complaint.
- D5 FIXED (quota-exhausted refusals feed the card honestly with reset time) Insights "Backend quota" card shows "no reading yet" for codex even though a run just failed with an explicit quota-exhausted provider message (with reset date). Feed quota-error signals into the card.
- D6 FIXED (Coordination overhead card: operator share of reported spend, null-honest) Insights: operator runs are 16/23 and $2.32/$4.13 (56%) — consider an "orchestration overhead" metric (operator cost per delivered task / vs specialist cost).
- D7 OPEN /insights document title missing (same as F31-1/D1 — confirmed again: title empty on data-filled page).

## F. Live-use findings (pass-31 session)

- F1 FIXED (see batch 2; reconciler provenance + card collision row + evidence heal) - was MEDIUM, mixed-source stats): The collision protections themselves are excellent — policy-engine note at engage time ("PR #232 stands on vib-1 but is NOT VIB-1's review PR"), delivery refused non-fast-forward with honest timeline event, operator packet with push_conflict evidence + delete-and-redeliver pick. Residual defect: task frontmatter github.changed (files 14/+313/−30) and the auto-appended evidence lines on the agent's completion report ("14 file(s) changed on vib-1 +313 −30", "2 commit(s) delivered") derive from the STALE REMOTE branch while github.commits correctly lists only local e46279a — foreign stats attributed to the delivery, shown on the GitHub card as "Diff 14 files +313 −30" with stale commit list; agent's report even claims "2 commit(s) delivered" it never made. Fix: derive changed-stats strictly from the delivered revision (local), or suppress stats while branch is collision-flagged (unownedPr set).
- F1b CONFIRMED (operator behavior): operator relay comment asserted "there is currently no qa/smoke README in this repo" while its own triage packet had cited qa/smoke/README.md (which exists on main). Relay claims are not re-verified; consider grounding-check on relay assertions or softer copy.
- F1c OBSERVATION (agent behavior, sonnet specialist): Docs Writer substituted demo-data roles (admin/maintainer/contributor) for the operator's explicit "Maintainer, Contributor, Viewer" list, and its validation notes claim compliance. Kept for reviewer/rework-loop test.
- F2 CONFIRMED (GOOD): Specialist run failure (Codex quota) produced a proper Blocked decision packet: signal + provider message verbatim + 5 recovery options incl. "Retry on Claude" (operator pick, sticky backend switch). Codex quota exhausted til Sep 18 → Codex live-parity tests blocked externally; config-side parity captured via run_inputs (mounts correct: skills [], kb [pass31-qa-conventions], mcp [qa-echo], delivers true, denied gh pr merge).
- F3 CONFIRMED (GOOD): Operator triage on ungroundable goal raised a decision packet with evidence table + 4 options; headline copy overclaims ("KB doesn't exist" — it exists at instance level, just not granted to any DEPLOYED specialist). Improvement: packet copy should distinguish "not granted here" from "does not exist"; app could surface instance-level near-matches.
- F4 OBSERVATION: operator triage on VIB-1 burned 43 turns/$0.79 mostly Read-ing repo docs hunting for the phantom KB before packet. Consider a triage turn budget or earlier packet raise.
- F5 CONFIRMED (GOOD): controller instance summary accurate (projects, roles incl. invited nuance, backends, live runs) and stage rename executed + verified on board; conversations run as agent_runs (kind=controller) with cost tracked ($0.14).

- F7 OBSERVATION (design praise + copy nit): operator relay/goal-draft flow for rescope requires two ceremonies (packet resolve → confirm drafted goal → human saves in goal editor). Defensible (goal edits are human-gated; set_goal refuses overwrite) but the drafted text leaked the option TITLE as the goal's first line ("Confirm rescoped goal: ... via Docs Writer"); strip option-title from drafted goal text.
- F8 CONFIRMED (GOOD, R17 family): outside merge of an open PR does not close the task; verdict gate holds; acceptance dialog adapts ("Nothing merges..."); closed-PR → divergence note + withdrawal of moot recommendation + combined recovery packet citing unreviewed head commits; archive+delete ceremony coherent and executed remote branch deletion.
- F9 OBSERVATION: task card commits list lagged behind diff stats after outside push (diff counted the outside commit, commits list showed only reviewed one) until reconcile.
- F10 OBSERVATION: schedule UX is clean (Run operator → "Schedule" label swap, schedules recorded in frontmatter with creator attribution).

## E. QUESTION queue for owner (with context)

- E1 (from 00 Q2/Q3) Controller: policy-edit carve-out makes "has a ceremony" the real always-human test; org admins can read project-scoped controller transcripts (vs R15-4 members-only secrecy). Intended?
- E2 (from 00 Q13) Controller + chained goals absent from UX spec and architecture.md — document post-hoc, or leave rulings as canon?
- E3 (from 00 Q7) Three-browser support matrix claimed but only chromium exercised — verify or strike?
- E4 (from 00 Q9) FR33 90-day audit hard-delete has no ruling number and no long-term export path beyond S3 schedule — accept as-is?
- E5 (from 02) Codex runs have no read-only sandbox anymore (workspace-write even for reviewer/operator) — Claude-only enforcement for repo-write family. Comfortable, or add compensating guard?

## R. Self-review round (2026-08-31, PR #253 pre-merge)

High-effort /code-review of main...pass31/implementation: 5 finder agents (8 angles) -> 19 deduped candidates -> 19 adversarial verifiers -> 16 CONFIRMED + 1 PLAUSIBLE + 2 REFUTED. Every surviving finding FIXED on the same branch, all canaried, full gates re-run.

- V1 FIXED: archiveDisclosure producer never passed unownedPr -> collision confirm omitted "closes its pull request #N". Field made REQUIRED; page passes task.unownedPr; page-level tests. Live-proven on :5174 (dialog names PR #249).
- V2 FIXED: T13 dedupe made per-recipient (packet/quality are independent per-user categories). notifyTaskWatchers gained exceptUserIds; operatorOpenPacket returns notifiedUserIds; StuckLoopEscalation is now an object.
- V3 FIXED: coordination overhead numerator now kind IN (operator, controller), folded into the existing totals SELECT (third aggregate deleted). Live-proven: 100% on an operator+controller-only instance.
- V4 FIXED: exhaustion recorded only on usage-limit/quota provider wording (transient 429/rate-limit excluded); resetsAt-null records get a bounded TTL; panel prefers a NEWER reading over a stale exhausted row.
- V5 FIXED: reconciler records compare-derived commits only on POSITIVE provenance (owned PR, cached pr, or workRevision on this branch); unproven caches dropped instead of carried forever; PR-less squatters no longer credited.
- V6 FIXED: excludes settings write is a reported precondition (settingsWritten); write failure mounts NOTHING (prompt-text fallback); strip overwrites settings.json in place for preserved live mounts (fail-closed delete otherwise).
- V7 REFUTED: zero-option packet still resolvable via always-offered custom directive. V8 REFUTED: SDK claudeMdExcludes matcher is memory-type-gated; SKILL.md scanning unaffected.
- V9 FIXED: prose reset dates parsed via Date.UTC + 24h grace (QUOTA_RESET_GRACE_MS); prose-derived resets render date-only (resetsAtPrecision exact|prose).
- V10 FIXED: withdrawSupersededDeliveryPacket family marker widened to discard_branch OR resolve_remote_collision (F29-7 regression closed).
- V11 FIXED: successful resolve_remote_collision lifts readiness blocked->ready in the outcome write (failure arms keep the block; waiting stays human).
- V12 FIXED: orgResources uses new names-only readers (listKnowledgeBaseNames/listSkillNames/listMcpServerNames) - no scanStoreTree/readSkillBody on get_task.
- V13 FIXED: queue.latest coalescing carries strandedResume forward (and max transitionDepth).
- V14 FIXED: backend-quota now uses shared getSetting/setSetting/deleteSetting from instance-settings (three duplicate accessors deleted).
- V15 FIXED: collision arm's duplicated note blocks unified into one noteText write.
- V16 FIXED: one PacketDestructiveConfirm shell for all three ceremonies; PACKET_TIER_GATES map replaces 5 parallel kind-chains and closes the missing collision arm in the .od description.
- V17 FIXED: shared tolerantRowsOf in file-diagnostics.ts used by task frontmatter lists, project tolerantArray, and the packet-option probe.
- V18 FIXED: durable heldAtStage frontmatter marker - backstop stays quiet while the hold stands; cleared by transitions, packet resolutions, goal edits (deliberately NOT by manual drives).
- V19 FIXED: resolve_remote_collision taught at point of use (push_conflict tool result, turn doctrine, deliver_for_review description, prAdoptionRefusalNote); snapshot gained unownedPr; CLONE_TIMEOUT_MS/CLAIM_LEASE_MS now lazy cloneTimeoutMs()/claimLeaseMs().
- Also: stale absentMode comment in agents-query.server.ts rewritten for the F31-C2 gate() polarity.

Gates after fixes: vitest 4741 green (was 4708), tsc 0, lint 0 errors + 2 pre-existing warnings, build green, compose e2e green. Live UI validation: collision dialog PR clause + coordination card on :5174.
