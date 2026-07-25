# Pass 14 — walkthrough notes (live UI, 2026-07-25)

Lead's own observations from browsing the running app (dev server `viberr-dev`, logged in
as `arda@viberr.dev`, admin). Code-map docs from discovery subagents live in `docs/`.
Findings ledger: `FINDINGS.md` (built in phase 2). Use-case results: `USECASES.md`.

## Instance state at start of pass

- 3 projects: **Lightweight Lab** (legacy 3-stage `todo/doing/done` from the dropped
  Lightweight template, 1 blocked task LL-1), **Pass13 Selftest** (6 tasks, PST-1..6,
  the pass-13 live-validation project), **viberr** (pre-pass13 project, 1 Done task,
  0 active members — only a removed account; Arda reaches it via org-admin override).
- Org resources: KBs `release-checklist` (6 docs), `p13-facts` (2 docs, 1 template);
  MCP `everything-mcp` (stdio, 16 tools), `everything-http` (HTTP :3031, 16 tools),
  `broken-mcp` (/bin/false, unreachable); skills `p13-selftest-skill`,
  `developer-expertise`, `reviewer-expertise`, `viberr-app-expertise`; global profiles
  `Developer`, `Org Docs Writer`, `Reviewer`.
- 20 unread notifications; 5 open decisions (2 blocked, 2 approvals, 1 completion).

## Live leads inherited from the instance (to re-test in phase 3)

1. **Codex host-skill leakage evidence in PST-3 timeline** — the preserved context audit
   (21:46 on 07-24) lists ~20 HOST skills (`github:yeet`, `skill-installer`,
   `apple-design`, `openai-developers:*`) in a Codex run. The isolation fix commits
   landed later (23:16–02:26), so this is pre-fix evidence, NOT proof of a live bug.
   **Must re-run a fresh Codex context audit this pass.**
2. **PST-6 blocked decision (open): "Codex KB access is inconsistent across runs"** —
   verification runs disagreed on whether `p13-facts` was provisioned to the Codex
   backend; also "no diff/PR evidence of the edit is visible in task state" despite a
   claimed commit `9bc3fad` on branch pst-6 (GitHub page shows pst-6 "not compared",
   no PR). Open product/runtime question: KB → Codex reliability + branch-evidence
   surfacing for undelivered work.
3. **LL-1 blocked decision (open): no profile eligible for legacy stage id `doing`** —
   dropping the Lightweight template stranded existing projects using its stage ids:
   every profile declares `ready/impl/review`, so nothing can be engaged. Needs an owner
   ruling: remap legacy stage ids / per-project eligibility editing / archive guidance.
4. PST-2 and PST-3 have open operator recommendations (accept-completion, move-to-review)
   — good material for testing the approval flows.

## UI observations (candidate findings; verify + file in FINDINGS.md)

- **KB store browser is create/delete-only**: file rows have a Delete button and nothing
  else — no way to open, read, or edit an existing KB document in-app ("New document"
  authoring exists, pass-13 ruling #3). The natural completion is view + edit.
- **Agent log viewer dumps raw wire telemetry**: `rate_limit_event` JSON blobs and dozens
  of `system·thinking_tokens` lines render as timeline rows in the human-facing log
  (seen on PST-3). Needs filtering/humanising (relates to pass-13's "humanise packet
  observation keys" which fixed packets, not logs).
- **Waiting-on counts differ across surfaces with no reconciliation**: home says
  "5 decisions waiting on you" (org-wide), Pass13 board header "4 waiting on a human
  decision", Agents page "6 threads waiting on a human". Likely all technically right
  with different semantics, but unlabeled and confusing side by side.
- **Org Docs Writer profile anomaly**: Policy page lists it with **18 direct**
  capabilities (others: 2–10) and its role label duplicates its name ("Org Docs Writer ·
  Org Docs Writer"). Deployed from the template library — check grant defaults
  (pass-13 f811933 made org templates start delivery-withheld; 18 direct suggests
  something broader survives).
- "1 context resources" grammar on global profile cards (org settings).
- MCP server cards show "16 tools · checked 12h ago · stale, retest" — good honesty;
  `?tab=` URL params on the project Agents page don't switch tabs (capability matrix
  opens via button only; the org settings page DOES use `?tab=`).
- Board card chips: a task in the In Progress column can wear a green `ready` readiness
  chip (PST-3) — readiness vocabulary next to stage columns reads oddly; check whether
  `ready` chip on non-Ready stages is intended.
- Review queue honestly surfaces the rejected-PR divergence (PST-5, "PR #99 closed
  without merge — reopen or archive"). GitHub page branch table: pst-5 shows "synced"
  even though its PR is closed — mixed message with the queue's "decision required".
- Notifications page: rich and honest; decision cards link through; "Mark read" per row.
- viberr project settings: honest "0 active · 1 removed account" + "The org account was
  deleted — remove this stale membership." (display side of pass-13 UI-29 addressed;
  last-admin-guard code side still to verify).
- Capability matrix modal: per-profile dots + CLAUDE-ENFORCED badges + honest Codex
  advisory disclosure. Renders well.
- Activity page: stream (All/Humans/Agents/System) + audit log; workflow-stage
  add/remove entries recorded (02:09/02:10 today — pass-13's own regression sweep).

## Later walkthrough additions

- **"Needs attention" board filter misses PR divergence**: it matches only `blocked`
  (PST-6); PST-5 — closed-without-merge PR, "Decision required" in the review queue —
  doesn't qualify. A divergence that demands a human decision should count as needing
  attention.
- Topbar "Search tasks, branches, agents… ⌘K" is an inline filter over the current board
  (composes with the chips; "0 of 6 tasks" when nothing matches). No global palette; it
  only exists on board-bearing pages. Check against mock intent.
- List view (`?view=list`) works; stage pill has an inline chevron (quick stage menu).
- Light theme via prefers-color-scheme renders cleanly (app theme "System" honored).
- PST-6 GitHub card is honest (branch pst-6, commit 9bc3fad, "not yet synced with
  GitHub", "no PR", "Acceptance is blocked…", Force accept present) — the blocked
  packet's "no diff/PR evidence visible in task state" line was overstated.
- App-owned CODEX_HOME (`docker-data/runtimes/codex-home`) contains `.system` bundled
  skills (imagegen, openai-docs, plugin-creator, skill-creator, skill-installer)
  materialized 07-24 18:24 (pre-fix) — the exact extra names in the leak report, plus
  host plugins (`github:*`, `openai-developers:*`, design skills) that must have come
  from the host env. Whether a fresh run still sees any of these is THE phase-3 check.
- Governance subagent highlights to fold into FINDINGS: contributor-owner "waiting on
  you" dead-end (GV-01); FR37 drift is doc-side (owner acceptance IS implemented, GV-04);
  `closedPrBlockedReason` says "archive the task" but task archive doesn't exist (GV-02);
  `operatorPromptAgent` directive comment skips notifyMentionedUsers (GV-06);
  accept-merge before packet-identity recheck (GV-05); accepted-then-closed-externally
  PR loses its Complete-merge affordance silently (GV-09). better-auth migration is
  COMPLETE (memory note stale).

## Surfaces still unvisited (do during phase 3 so state mutations are purposeful)

- New-project dialog, new-task dialog, template library "Add from library" flow,
  MCP add/edit dialog + probe UX, KB "Add from GitHub", search (⌘K), task drag between
  stages, comment composer + @mention picker, engagement controls on a task, org
  settings users/connections tabs in edit mode, theme toggle (light mode shots),
  archived projects view, force-accept flow, packet resolve flow.
