# Pass 20 — Use-case catalog (live-run on the fresh instance)

App: production compose container on :5173, project **Viberr** (`akin-ozer/viberr`, key VIB).
Driver: playwright HTTP driver on 127.0.0.1:7788 (`scratchpad/drv.py` — goto/click/fill/eval/text/shot).
Login: arda@viberr.dev. Evidence: screenshots into `screenshots/`, results recorded per-UC here.

Status: PENDING / PASS / FAIL(→finding) / PARTIAL. Every FAIL must reference a FINDINGS.md id.

## A. Core delivery loop
- **UC-01 Full governed delivery loop** — create task → operator triage (auto boundaries) →
  developer implements → server delivery → PR → reviewer verdict (revision-pinned) → operator
  accept recommendation → human ceremony → Done + real merge.
  **PASS** (VIB-1 / PR #160 merged 2026-08-14). Detours became F20-4, F20-5.
- **UC-02 Rejected-work path** — task whose PR the human REJECTS: request changes / close PR
  via gh, verify viberr reflects the closed PR honestly (pr-diverged/closed state, recovery
  packet), then archive-with-branch-delete disclosure. PENDING
- **UC-03 No-change completion** — **FAIL → F20-6 / ruling R20-2** (VIB-2: empty branch +
  unflagged completion stranded acceptance; operator powerless; human decision unexecutable;
  closed via force-accept). Re-test after the R20-2 fix lands.
- **UC-04 Force accept** — **PASS** (VIB-2: ceremony disclosed MERGES: none / REVISION /
  VERDICT: awaiting / BYPASSING: the exact refused gate / "Admin override — recorded to the
  audit log"; task went Done·accepted). Nit: validation chip still says "awaiting verdict"
  after the bypass (in FIX-SPECS smaller items).
- **UC-05 Update task branch after base moves** — merge something to main while a task branch
  is open; use the update-branch operator capability (N19-9 gate); verify merge+push by server
  and honest divergence surfacing. PENDING

## B. Browser capability (owner focus, R19-19)
- **UC-06 Claude browser run E2E** — **PASS, with governance bonus** (VIB-2: operator chose the
  UX Verifier by description; viberr_browser mounted; agent navigated GitHub, hit the private-
  repo 404 login wall, captured 2 PNGs + page snapshots + console logs into
  `/data/projects/viberr/tasks/VIB-2/attachments/` (default-named → output-dir as designed),
  REFUSED to enter credentials per the injection stance, fell back to git-ref verification,
  cited attachment filenames in its report table). Evidence: screenshots/27-*, task timeline.
- **UC-07 Codex browser parity** — same-shape task for Developer (codex). Expect same mount +
  `--image-responses omit` (model can't SEE the pixels — verify it still saves and cites files).
  PENDING
- **UC-08 Egress interlock** — profile with use-browser=Allowed but use-web-search-fetch=Off:
  expect NO mount + contradictory-pair disclosure through run inputs (P14-LV-09), never silent.
  PENDING
- **UC-09 use-browser default-off** — new profile: browser starts Off; org MCP registry knows
  `viberr_browser` is a reserved name (save refusal both spellings). PENDING
- **UC-10 Attachment serving governance** — non-member fetches an attachment URL → 404 (not
  403); traversal attempt → 404; HTML attachment served download-only (nosniff, CSP sandbox).
  PENDING (needs a second user + a saved HTML attachment)

## C. Resources: skills / MCP / KB
- **UC-11 Skill selective loading** — Developer holds pr-etiquette (canary AMBER-FALCON-7) AND
  kubernetes-tuning (decoy CRIMSON-YAK-99). Task instructs "consult your skills for PR
  conventions and state them". Expect canary cited, decoy NOT loaded (check run log Skill tool
  calls). PENDING
- **UC-12 KB live-folder read** — task asks "what is the KB canary phrase?"; expect
  BLUE-HERON-42 from store://kb/viberr-test-conventions/. Then edit the doc on disk mid-task and
  confirm next run reads the live folder. PENDING (first half provable in UC-11's run)
- **UC-13 Org MCP tools usable by agent** — task requires calling the `everything` MCP echo/add
  tools; verify Claude spelling `mcp__everything__*` vs Codex `mcp_everything_*` dialects both
  work (pass-19 canon). PENDING
- **UC-14 MCP failure honesty** — register a server whose command exits with an error →
  row shows its stderr words (R19-17), persisted across reload (17b); remove it after. PENDING
- **UC-15 Warm-up honesty** — (observed live already: uvx web-fetch row went
  "installing on first use — finishing in the background" → verdict; npx cold-start gap noted
  as N20-2). PARTIAL — re-verify web-fetch row turned green, then PASS/FAIL.

## D. Governance / RBAC
- **UC-16 Role matrix on task surface** — invite a second user as Viewer; verify: no create
  task, no run agents, no accept, comments allowed?? (viewer: read-only — check ACTION_ROLES),
  members-only project 404 for non-members (R15-4). PENDING
- **UC-17 Contributor boundaries** — promote to Contributor: create task/take ownership yes;
  approve stage transitions / resolve packets / accept completion no. PENDING
- **UC-18 ALWAYS_HUMAN locks** — confirm no path lets an agent merge (merge-pull-request
  human-only): operator accept_completion in recommend mode produced a recommendation, not an
  action (observed UC-01) — extend: set completion-for-acceptance=direct + autonomy full on a
  scratch project and verify operatorAcceptCompletion is disclosed on Policy page. PENDING
- **UC-19 Autonomy ceiling clamp** — profile autonomy above project ceiling gets clamped with
  typed `task.operator.autonomy_clamped` event (R19-A). PENDING
- **UC-20 Owner/assignment flows** — Assign me / take-release ownership; secondary assignment:
  engage UX Verifier alongside Developer on one task (two engagements, one delivers). PENDING

## E. Collaboration
- **UC-21 Comments + @mention notify** — human comments @operator; agent replies must @tag the
  asking human and notify (bell + inbox, agents-tag-humans convention). PENDING
- **UC-22 ask_human flow** — task instructing the agent to ask a clarifying question before
  proceeding; expect askedBy packet/question surfaced, human answer resumes run (G19-h family).
  PENDING
- **UC-23 Notifications auto-read on view** — generate notifications, open the task page,
  verify they mark read (R19-15) and the bell badge drops. PENDING
- **UC-24 Search/⌘K** — search for VIB-1 by title fragment and by key; palette navigates.
  PENDING

## F. Codex/Claude parity
- **UC-25 Same-shape task both backends** — two sibling tasks (marker file A/B), one Developer
  (codex), one clone profile on claude; compare: timeline events, run console rendering
  (thought folds/tool chips), delivery, PR text, verdict flow. PENDING
- **UC-26 Backend switch mid-task** — operator backend toggle Claude↔Codex on the task page;
  verify a re-run uses the switched backend and the run console labels it. PENDING

## G. Board / stages / projections
- **UC-27 dnd board move + entry-stage rule** — drag a card between lanes (server-authoritative
  move); verify off-boundary moves are refused honestly (pass-19 trap: server 409s off-boundary
  move); new-task button only on entry lane (R19-14 — observed PASS visually, confirm via DOM).
  PARTIAL
- **UC-28 Stage editor** — add a stage, rename it, move it, remove it; boundary inheritance per
  settings copy; then restore. Verify tasks re-anchor. PENDING
- **UC-29 Re-scan & rebuild projections** — edit a task.md on disk (title tweak), Re-scan store,
  verify board reflects it; Rebuild projections keeps state identical. PENDING
- **UC-30 Second project isolation** — create project 2 (public-repo import path, no PR use);
  verify agents/resources scoping, board separation, and that the viberr project's resources
  don't leak. PENDING

## Owner ground rules honored
- PRs only against akin-ozer/viberr; only small test files (test-artifacts/*); merges of tiny
  markers OK; some PRs deliberately closed unmerged; no software bloat in accepted changes.

## Batch-1 live-run results (2026-08-14) — verifier CONFIRMED every claim
Status per UC exercised in batch 1, with the consolidated FINDINGS.md ids each produced.
- **UC-02 Rejected-work path** — PASS. Findings: F20-23, F20-24, F20-25. (VIB-8/PR #162 closed
  on GitHub, recovery packet + branch-delete disclosure all honest; no surface called it a merge.)
- **UC-08 Egress interlock** — PASS, no defect. Interlock disclosed, browser NOT mounted when
  egress withheld (verified non-finding).
- **UC-09b use-browser reserved-name refusal** — PASS. Findings: N20-5. (`viberr_browser`/`viberr`/
  `viberr_agent` all refused; slug refusal quotes a name the admin never typed.)
- **UC-11 Skill selective loading** — PARTIAL. No new defect. Behavioural canary passed; the
  Codex-injects-all-skills-as-text asymmetry is the sanctioned ruling 51 / R18-5 divergence
  (verified non-finding).
- **UC-12 KB live-folder read** — PASS, no findings. Canary BLUE-HERON-42 byte-exact end-to-end.
- **UC-13 Org MCP tools usable by agent** — PASS (both dialects proven; PR #161 merged). Findings:
  F20-10 (a failed MCP contributes zero tools while the UI says "healthy").
- **UC-14 MCP failure honesty** — PASS. Findings: F20-7 (sub-8-char credential plaintext leak, HIGH),
  F20-22 (exit code dropped). The app-wide outage F20-8 was observed during this lane's window.
- **UC-15 Warm-up honesty** — PASS, no new defect. web-fetch warm-up settled to a real failure
  verdict (upstream ImportError); context only, relates to N20-2.
- **UC-16 Role matrix / invite surfaces** — PASS. Findings: F20-12 (dead passwordless invite), N20-6
  (invite "email sent" copy).
- **UC-17 Contributor/maintainer boundaries** — PASS. Findings: F20-16, F20-17, F20-18, N20-7, N20-8.
- **UC-19 Autonomy ceiling clamp** — PARTIAL (clamp could not be observed biting). Findings: F20-9
  (supervised operator "acts directly" acceptance card, HIGH, ⇄ PRD D1), F20-19, F20-20, F20-21.
- **UC-23 Notifications auto-read on view / profile** — PARTIAL (unread badge never persisted long
  enough to screenshot). Findings: F20-11 (background-revalidation auto-read, headline), N20-12, N20-13.
- **UC-24 Search / ⌘K** — PASS. Findings: F20-28, F20-29, F20-30.
- **UC-28 Stage editor** — PASS. Findings: F20-13 (round-trip tightens a boundary silently), F20-26,
  F20-27, N20-9, N20-10.
- **UC-30 Second-project isolation** — PARTIAL (no public-repo import affordance at create). Findings:
  F20-14, F20-15, N20-11.
- **App-wide (observed during lane A)** — F20-8: silent crash → self-lockout unbootable container
  (nine boot refusals; EPIPE-on-child-stdin candidate).
