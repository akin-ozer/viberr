# Findings backlog — discovery pass 16 (2026-08-04)

## Owner rulings this pass (binding)

- **R16-1 — PR adoption.** A pre-existing PR becomes a task's PR ONLY IF it is OPEN *and* its head SHA equals the
  task's delivered revision. Merged or closed PRs that merely share the task-key branch name are never adopted;
  they are ignored with a timeline note (and, where delivery is blocked by them, surfaced as a divergence).
  Rationale: adoption existed for genuine recovery (Viberr lost track of a PR it opened); name matching alone
  proved it can bind a foreign merged PR to a task that delivered nothing.
- **R16-2 — Attention filter.** `input_required` joins the board's risk predicate, and the chip is renamed
  **"Blocked or waiting"** so it plainly means "work that cannot proceed" (blocked, input_required, failing
  validation, urgent, closed PR). The e2e/unit test asserting the old behavior is updated, not worked around.
- **R16-3 — Refusal ordering.** Terminal GitHub facts outrank process gates in acceptance-refusal copy: a closed
  (or elsewhere-merged) PR is named as the blocker instead of the missing verdict, and **force-accept is hidden
  while the PR is closed** — the recovery packet is the path.
- **R16-4 — Scope order.** Every S1/S2 correctness item lands first, with tests; then the full UI/a11y list.
  Nothing is deferred out of the pass.
- **R16-5 — MCP stays outside the capability matrix** (answers Q-C3). Viberr cannot know what a third-party tool
  does, so it will not pretend to bound one: granting a server IS the grant, and an agent whose
  `execute-code-or-write-repo` is withheld still gets whatever a granted server's tools can do. The decision is
  the ruling; the work is making it explicit rather than looking like an oversight — the disclosure now names
  the consequence, and `specialist-tool-policy.test.ts` pins the absence of an `mcp__*` deny rule so the
  "obvious fix" (denying `mcp__*` alongside Edit/Write) cannot land silently and revoke read-only servers.
- **R16-6 — Merge stays human-only** (answers Q12/G5). `merge-pull-request` remains in `ALWAYS_HUMAN`, so a
  full-autonomy task reaches the done stage with its PR open. That is intended; what was not intended is that
  "Done" therefore means two different things by preset and the board drew only one of them. The
  merge-pending state (`pr.state: "accepted"`) and the closed-PR state must be visible where the task is —
  card and review queue — not only on the detail page.
- **R16-7 — `codex/gpt-5-6-sol-agents` deleted.** The branch added a root `AGENTS.md` — a GPT-5.6-Sol harness
  working agreement, not product code — and cited `docs/contributing-quickstart.md` / `docs/testing-quickstart.md`,
  neither of which still exists. Deleted local and remote after review; tip `461d34ab` if it is ever wanted back.


Master backlog feeding the implementation phase. Sources: 7 doc agents (see sibling docs), live UI walkthrough
(UI-WALKTHROUGH-NOTES.md), and live product usage. Status: `new` (from code reading, unverified),
`live` (reproduced/observed in the running app), `fixed-in-pass` (fixed during this pass), `question` (owner decision needed).
Severity: S1 critical / S2 significant / S3 polish.

The full detail for every item lives in the source doc named in brackets. This file is the index + disposition ledger.

## A. Security / correctness — S1

- [ ] A1 S1 `new` [ARCHITECTURE §11] `model-catalog.server.ts:356` probes Claude with `options: {}` → SDK falls back to full `process.env` (PAT, session/encryption secrets, provider keys) and host `~/.claude`. Reachable from agent create/edit UI. Likely regression of F10-02.
- [ ] A2 S1 `new` [AGENTS-RUNTIME §9.1] `acceptancePrHeadMismatch` bypassable on 2 of 4 Done-writers (`operatorAcceptCompletion`, `completeTaskMerge`); poller nudges humans into merging stale-head PRs. The "ONE gate force can NEVER bypass" docstring is false.
- [ ] A3 S1 `new` [AGENTS-RUNTIME §9.2-3] failed `git rev-list` indistinguishable from "no commits" in `push-workspace.server.ts:315`; `performDelivery` doesn't special-case `no_commits`/`no_workspace`/`no_repo`/`no_branch` → falls through to `openTaskPr`. Plus shallow-clone default-branch comparison blind spot.
- [ ] A4 S1 `new` [DOMAIN-MODEL §12] Undeployed operator can still deliver: `deliverGate` never denies; 4 `runOperator` callers skip `authority.deployed`; empty policy from no-deployment branch.
- [ ] A5 S2 `new` [AGENTS-RUNTIME §9.13] `readSkillBody` has no symlink containment (KB reader has); symlinked SKILL.md injected as trusted persona.
- [ ] A6 S2 `new` [AGENTS-RUNTIME §9.12] Operator persona lacks the trusted-provenance banner AND MCP-governance rule that specialists get.
- [ ] A7 S2 `new` [RBAC §7.20/7.10] CSRF origin check passes when both Origin and Referer are absent.
- [ ] A8 S2 `new` [AGENTS-RUNTIME §9.14] fine-grained scope probe does a real `PUT /contents/viberr-scope-probe` on the user's repo at every revalidation.
- [ ] A9 S2 `new` [AGENTS-RUNTIME §9.15] secret-key rotation unimplemented; MCP creds fail SILENTLY to unauthenticated on key mismatch.

## B. Operator / delivery logic — S2

- [ ] B1 `new` [AGENTS-RUNTIME §9.4] operator-authored `retry_other_backend` always retries on Claude (`?? "claude"` fallback; schema lacks backend/profileId).
- [ ] B2 `new` [DOMAIN-MODEL §12] `operatorResolvePacket` can silently withdraw an agent's ask_human packet (no from/kind ownership check) → R15-14 askedBy resume never fires.
- [ ] B3 `new` [DOMAIN-MODEL §12] `operatorOpenPacket` has no already-open guard; overwrites `parsed.packet` unconditionally (siblings guard).
- [ ] B4 `new` [DOMAIN-MODEL §12] transition-chain cap off-by-one: `>=` in `transitionStage:3176` vs `>` in `operator-run:467` (9th link possible via stranded-resume).
- [ ] B5 `new` [AGENTS-RUNTIME §9.9 / DOMAIN-MODEL] `escalateFailedOperatorRun` releases lease BEFORE writing the blocked packet (Claude path; Codex path correct) — successor races the packet.
- [ ] B6 `new` [AGENTS-RUNTIME §9.10] `maybeResumeStrandedOperator` silently disables itself when task-file read fails (stageAtStart:null short-circuit, no log).
- [ ] B7 `new` [AGENTS-RUNTIME §9.5-6] Store seeded before hash manifest never converges — `./data` store operator.md pinned to pre-rewrite SOP naming dead tools (`prompt_specialist`, `assign_specialist`); docker-data is correct. Also two seed writers disagree on operator MCP grants (`agent-catalog.server.ts:90` `["viberr"]` vs asset `[]`) → red "reaches no run" chip.
- [ ] B8 `new` [AGENTS-RUNTIME §9.11] operator prompt advertises DECLARED MCP servers, not RESOLVED (the honesty failure P14-LV-09 fixed for specialists).
- [ ] B9 `new` [AGENTS-RUNTIME §9.16] `nudgeMergePendingTasks` matches on a JSON substring.
- [ ] B10 `new` [DOMAIN-MODEL §12] queued-run id can leak as literal string "queued"; cross-boot queued trigger can strand behind a restart orphan.
- [ ] B11 `new` [AGENTS-RUNTIME §9.7-8] `deleteTaskRemoteBranch` doesn't URL-encode branch; zero-scope classic PAT lands on `source:"assumed"`.

## C. Resources (KB / skills / MCP) — S2

- [ ] C1 `new` [DOMAIN-MODEL §12] KB and skill grant misses are logger-only (MCP misses reach the run prompt as structured unresolved) — surviving half of the silent-resource class.
- [ ] C2 `new` [DOMAIN-MODEL §12] Skill injection budget is per-skill (N×24k unbounded); KB budget is global.
- [ ] C3 `new` [DOMAIN-MODEL §12 / matrix copy] MCP tools entirely outside capability system (prompt text only) — matches UI disclosure, but an org MCP with write powers bypasses `execute-code-or-write-repo`. (Product stance? → question Q-C3)
- [ ] C4 `new` [DOMAIN-MODEL §12] rename ↔ KB-watcher race: >250ms `updateResourceReferences` await lets watcher adopt new dir as fresh row → `dir UNIQUE` collision.
- [ ] C5 `new` [DOMAIN-MODEL §12] `scanStoreTree` follows symlinks that `readKbBody` refuses; editable-but-not-injectable `.json`/`.yaml` KB docs; `touchResource` bypasses `manual` refresh pin.
- [ ] C6 `new` [ARCHITECTURE §11] `@lexical/utils` phantom dependency (imported, not in package.json, resolves via hoisting).
- [ ] C7 `new` [AGENTS-RUNTIME] Claude `skills: []` does not empty the set (~16 compiled-in skills listed); Skill-tool denial is the real enforcement. Verify granted-skill-only loading LIVE in phase 2 tests.

## D. Runtime parity / adapters — S2

- [ ] D1 `live` [me] Dev `CODEX_HOME` misconfig class: launch.json pointed CODEX_HOME at the run home → auth source==home → mirror no-op → every Codex run refused. Fixed locally by dropping the export (a subagent reverted it via git checkout mid-pass; re-applied). Product fix candidate: warn when cached-login mode resolves source==home with no auth.json, or surface backend credential health on the Agents page (it already shows at task level: "Codex — not configured").
- [ ] D2 `new` [ARCHITECTURE §11] Claude CLI-auth availability is presence-only while Codex is file-validated (F-DOCKER1 shape reachable on Claude side).
- [ ] D3 `new` [AGENTS-RUNTIME design-tensions] `comment-on-task` is a no-op on Codex; `git add -A` ships the whole dirty tree; `sed -i`/`curl` reachable through Bash on Claude despite confinement; merge method hardcoded.
- [ ] D4 `new` [ARCHITECTURE §11] `resumeRun` can't re-apply `allowedTools`; specialist runs never add `mcp__*` to allowedTools (masked by bypassPermissions).
- [ ] D5 `new` [ARCHITECTURE §11] stale SDK-version comments; `rawLogPath` docstring wrong; documented `tools` escape hatch doesn't exist.

## E. RBAC / policy surface — mostly S2/S3

- [ ] E1 S2 `live+new` [RBAC §7.13, seen live on Policy page] Policy page renders "view/comment app-wide, membership not required" while enforcement 404s non-members (R15 members-only ruling). Display contradicts enforcement — fix display (and the stale §7.1 comment block in rbac.ts, §7.5 setOwner docblock, §7.6 hardcoded "Every registered user" comments panel — also live on VIB-1 Permissions panel).
- [ ] E2 S2 `new` [RBAC §7.3] board/agents/settings/github actions 403 (confirm existence) where task/policy actions 404 — visibility-leak asymmetry.
- [ ] E3 S2 `new` [RBAC §7.4] UI checks wrong action ids: `create-task` on board, `canEditGoal={canRunAgents}`, `release-any-ownership` sites, MembersPanel mapping.
- [ ] E4 S3 `new` [RBAC §7.14/7.15] disabled-without-reason buttons; decision-packet reason in `title` of disabled button (unreachable).
- [ ] E5 S2 `new` [RBAC §7.16] `review-queue.server.ts:140` returns true for everything when viewerUserId omitted.
- [ ] E6 S3 `new` [RBAC §7.17] notifications exclude org-admin overrideEligible while Home counts it — two answers to "waiting on you".
- [ ] E7 S3 `new` [RBAC appendix] 8 actions have no per-role test driver (view, comment, accept-completion, grant-github-scope, release-any-ownership, manage-members, manage-agents, edit-policy).
- [ ] E8 S3 `new` [DOMAIN-MODEL §12] unused `verification` table; stale scrypt comments; `task_projections.repo` dead column; `agent_runs.kind` stale 3-kind model; `agent_runs.outcome_key` missing from row interface.

## F. UI/UX — from UI-INVENTORY §8 (27 items) + live walkthrough

- [ ] F1 S2 No app-wide `:focus-visible` ring (4 selectors only).
- [ ] F2 S2 10 class names in TSX with no CSS rule; `.composer-box` missing `position:relative` (containing block via inline style on undefined class).
- [ ] F3 S3 184 inline `style={{}}`; `<select>` unstyled (4 ad-hoc treatments).
- [ ] F4 S2 Project-settings stage list uses hand-rolled HTML5 drag WITH grip (opposite of board idiom); KB browser is a third drag idiom.
- [ ] F5 S2 ⌘K palette listbox broken for AT (no aria-activedescendant/combobox, options not direct children); ⌘K bound twice.
- [ ] F6 S3 dead `--font-display` dup + dead token block; `.card.wait-human` no-op; `.board-wrap::after` fade always paints; `.top-search` input-vs-button divergence.
- [ ] F7 S2 6 hand-rolled Escape+outside-click popovers, no shared hook; 3 "row actions on hover" idioms (touch-hostile).
- [ ] F8 S3 toast stack unbounded; mobile rail scrim is clickable `aria-hidden` button; 1100px does 8 unrelated jobs.
- [ ] F9 S2 axe sweep misses activity/settings/github/org-settings/profile/notifications and never audits an open dialog; only two aria-live regions; `.mention` chips color-only for AT.
- [ ] F10 S3 3 files >1200 lines (task-detail-page 1761, home-page 1691, resources-panel 1471).
- [ ] F11 S3 PAT input `type="text"`; 4 SVG icon sources; `.stg-x` drifted into generic icon-button; `.gh-table .live-head` grid override leak; 2 SSE consumers with different disconnect stories.
- [ ] F12 S3 `live` "1 instance accounts" pluralization (org settings users tab).
- [ ] F13 S3 `live` Home footer exposes "Re-scan" + "Drop every projection row and re-project the whole store from files" as plain buttons on the landing page.
- [ ] F14 S3 `live` New-project repo field auto-derive appends after manual focus ("viberrviberr").
- [ ] F15 S3 `live` New-task dialog shows "A title is required" error state before first input.
- [ ] F16 S2 `live` Agents page shows profile "available" even when its backend has no credential (task-level Execution profile panel DOES show "Codex — not configured"). Surface credential health on Agents page / profile cards.
- [ ] F17 S3 `live` Seeded profiles say "Global base · customized for Viberr Core" — "Viberr Core" name source unclear; project is "Viberr". Check gagents seed copy.
- [ ] F18 S3 `live` Reviewer (Claude backend) shows "Advisory only · 6 lines the runtime does not read" — expected only for Codex? Verify advisory-count logic per backend.
- [ ] F19 S3 `live` audit stamps "today 0:18" (24h no leading zero).
- [ ] F20 S2 `live` rich-text.tsx own mention regex chips ANY @word on typed timeline events (no known-name check) — P13-LV-12 surviving surface [also ARCHITECTURE §11].

## G. Product-intent deltas & owner questions — see PRODUCT-INTENT.md §5 (12 questions)

Top queue (ask owner in batches during phase 2):
- [ ] G1 Q1 input_required vs "Needs attention" board filter — server half shipped, UI half not; apply pass-15 handback or record rationale.
- [ ] G2 Q2 closed-unmerged PR vs verdict-gate refusal precedence in review queue copy.
- [ ] G3 Q3 Home ⌘K unreachable by touch <1080px (.kbd display:none, no alternative).
- [ ] G4 Q11 unmerged `codex/gpt-5-6-sol-agents` branch adds root AGENTS.md with no planning record — merge or delete?
- [ ] G5 Q12 should full-autonomy operator perform the merge (Done means two things by preset)?
- [ ] G6 [TESTING-INFRA] `.env` VIBERR_DATA_ROOT=./data vs launch.json docker-data — the dual-writer setup; align .env to docker-data?
- [ ] G7 [TESTING-INFRA] `.dockerignore` not excluding test-support is load-bearing for e2e — document or make explicit.
- [ ] G8 [TESTING-INFRA] no better-auth schema regen path anymore (gen script + reference SQL deleted).
- [ ] G9 [ARCHITECTURE] zero `--viberr-*` tokens exist (memory/docs premise wrong — tokens are unprefixed `--bg`, `--fg`, `--blue`); correct the record everywhere it's cited.
- [ ] G10 [TESTING-INFRA] dead vitest glob `db/**/*.test.ts`; e2e numbering gap noted.

## H. Live-flow observations (running log)

- H1 `live` [OK] Operator loop verified end-to-end on VIB-1: triage concreteness check → auto Triage→Ready→In Progress → prompt_agent @developer delivers:true → Codex refusal → Developer blocked comment → operator packet with 4 recovery paths + operator-pick preselect. Cost surfaced per run ($0.10/$0.05/$0.05). Timeline fully attributed. Packet resolution ("Send back for another attempt") cleared the block and re-engaged operator.
- H2 `live` [OK] ViberrMCP toolkit: agent used ToolSearch select:mcp__viberr__get_task / transition_stage / prompt_agent — deferred-tool pattern works.
- H3 `live` Branch `vib-1` + "Diff 1 file · +5 −0" appeared on the task rail BEFORE any successful agent run (during the refused-Codex window). What is in that diff? Verify what created the branch/commit and whether refused runs should leave diffs. → check during PR delivery.
- H4 `live` [OK] Session survives dev-server restart; board state intact (files+DB).
- H5 `live` [OK] UC-9 vague goal ("Improve the app" / "Make things better overall.") → operator held it at
  Triage with readiness=input_required and waiting=human. Triage quality gate works.
- H6 `live` [OK] UC-2/3/4/5 RBAC enforcement battery (HTTP probes, 4 roles + non-member). Verified:
  · viewer: view 200 · comment 200 · create-task 403 · owner-take 403 · update-goal 403 · run-operator 403
  · contributor: create-task 200 · owner-take/release 200 · update-goal 403 · transition 403 · run-operator 403 · force-accept 403
  · maintainer: update-goal 200 · owner-take/release 200
  · non-member (signed-in): home 200; board/task/policy/settings/agents/github/activity/review ALL 404; comment 404
  Enforcement matches ACTION_ROLES exactly. Two display/consistency bugs CONFIRMED LIVE:
  · E1 CONFIRMED: Policy page + task Permissions panel claim view/comment are app-wide "membership not required";
    enforcement 404s non-members on both. Display contradicts enforcement.
  · E2 CONFIRMED: non-member POST create-task on /board returns **403** while every other route+intent returns 404 —
    existence leak, single outlier.
- H8 `live` **[NEW-S1] Stale-PR adoption by branch name — CONFIRMED, high severity.** VIB-4 (new task, this data
  root) got `pr: {number: 113, state: merged, title: "[VIB-4] Verify MCP tool and knowledge-base wiring…", checks 2/2}`
  written into its task.md — PR #113 is an UNRELATED PR merged 2026-07-28 whose head branch happened to be `vib-4`.
  Its head (93435df) has nothing to do with this task's revision (80e9b2c). Consequences seen live: the GitHub page
  lists VIB-4 ↔ #113 "merged" with a foreign title; the task rail showed a green "merged" badge for work that was
  never delivered. The operator DID catch it at delivery and raise a branch-collision packet (good), but the
  adoption already polluted the record. Combined with A2 (`acceptancePrHeadMismatch` bypassed by
  `operatorAcceptCompletion`/`completeTaskMerge`), a full-autonomy operator could "accept" a task whose PR is a
  foreign already-merged PR. Same class hit VIB-1 (adopted merged #109). Fix: never adopt a PR the task did not
  open unless its head SHA is the task's revision; treat name-matched foreign PRs as a divergence, not as the PR.
- H9 `live` [OK] UC-16/17/18 on Codex — agent context self-report (qa/smoke/context-report.md, VIB-4):
  skills = ONLY `developer-expertise` (no reviewer-expertise, no viberr-app-expertise, no host skills → isolation
  holds); KB = both docs readable with a correct verbatim quote (KB injection works, live folder read);
  MCP = 15 tools listed as `mcp__everything__*` with Codex's hyphen→underscore renaming visible
  (`get_annotated_message`), and a real `echo` call returned `Echo: viberr-mcp-probe`. MCP on Codex works.
- H10 `live` [OK] UC-30 rejection path: closing PR #124 unmerged via `gh` produced, within one poll cycle, a
  "Decision required" packet on the task ("PR #124 closed without merging — choose recovery path") with rework /
  reopen options, the honest note that reopening on GitHub is auto-detected and withdraws the packet, a
  "PR #124 · closed" badge, and a Policy-engine divergence notification. Strong behavior. TWO gaps:
  · G2 CONFIRMED: the right-rail acceptance refusal still reads "no approving verdict yet — run a review for a
    verdict, or an admin can force-accept" while the packet on the same screen says acceptance is refused because
    the PR is closed. The terminal GitHub fact should outrank the process gate in the refusal copy.
  · The BOARD CARD does not surface the rejection at all — it still shows "awaiting verdict" + "ready". Only the
    detail page tells the truth. (Card does become matchable by "Needs attention" via `pr.state === "closed"`.)
- H11 `live` [OK] UC-10/22/24 mentions + notifications: mention menu opens after `@`+1 char (by design —
  `detectMentionToken` requires a non-empty query; the placeholder "type @ to tag…" slightly oversells it),
  ranks agents first with match highlighting and role subtitles, inserts a plain-text chip. The operator answered
  the @mention, **tagged the human back ("@Arda Agreed — …")**, and the reply routed to the bell + notifications
  page. Notifications page groups "Waiting on you" (3 typed decisions: completion report / blocked decision /
  approval) vs "Everything else", with per-item Mark read. NEW-4 convention holds end to end.
- H12 `live` **G1 CONFIRMED: the "Needs attention" board filter matched 0 of 4 tasks** while the board simultaneously
  rendered an amber "input required" chip on VIB-4 and "waiting on you" on two cards. Predicate
  (`board-filters.ts:40-53`) covers inconsistency_risk_detected | blocked | validation failing | urgent | pr closed —
  `input_required` is absent, exactly the pass-15 handback that never landed. A board that flags a state with an
  amber chip and then hides it from its own attention filter is incoherent.
- H13 `live` [OK] Empty-column copy under an active filter is genuinely good: "The 1 task here is hidden by the
  'Needs attention' filter." — no silent truncation.
- H14 `live` [NOT A BUG — recorded so a later pass doesn't re-file it] The active filter chip appears blank in CDP
  screenshots and `getComputedStyle` can report color == background. Both are harness artifacts (transition snap +
  the stale-computed-style trap). A fresh read gives `rgb(27,29,37)` on `rgb(236,238,244)`. Verify CSS conclusions twice.
- H15 `fixed-in-pass` [F17 resolved] Seeded Developer/Reviewer profiles rendered
  `Global base · customized for Viberr Core` — a workspace name that exists nowhere in the product (it is a
  literal from the design mock; `notifications-page.tsx:23` documents the same mock literal as one that must be
  replaced). Meanwhile the app's own profile writer (`gagents.server.ts:282`) uses the honest `Global base`.
  Fixed: seeded profiles now use `Global base`, matching what the app writes for every profile a user creates.
- H16 `live` [NOT A BUG — recorded so it is not "fixed" later] The seeded catalog grants KB dirs
  `architecture-notes` / `api-contracts`, which do NOT exist in a boot-backfilled store — but this is already
  handled: `default-assets.server.ts:238-253` strips KB grants on the backfill path (`kbGrants: false`) precisely
  so they cannot dangle as an "N of 0" ghost, and `npm run seed` creates the backing dirs via `seedOrgResources`
  (`org-seed.server.ts:63,108`). Verified live: the clean-sheet instance shows Knowledge bases 0 and profiles
  with only their skill attached. I started "fixing" this and reverted — the mechanism is correct.
- H7 `live` Invited local users are gated by pwreset (`readiness` of accounts): sign-in succeeds but every page 302s
  to /login until intent=set-password completes. Correct behavior, but the "setup pending" pill is the only UI hint;
  admin-facing copy could say the user must set a password at first sign-in before they can be assigned work.

---

## Disposition ledger (end of pass)

The checkboxes above are the backlog AS DISCOVERED. This section is what actually happened, and it
was not taken from the commit messages: after the implementation waves, seven agents — one per
section — re-derived every item's true state from the tree. Over the 70 items that audit returned
**42 fixed, 3 not-a-bug, 7 owner-question, 7 open and 11 partial**. The open and partial ones
became wave 3, and the "partial" verdicts are the useful part of the record: several items had
landed convincingly enough to read as done.

Examples of what "partial" meant, so the shape is recognisable next pass:

- **E3** — three of four call sites were routed through `roleCan`; `MembersPanel` still read
  `myRole === "admin"`. The three that landed were also *unpinned*: `update-goal` and `run-agents`
  resolve to the same tier today, so a wrong action id would not have failed anything.
- **B11** — the URL-encoding half landed; the scopeless-classic-PAT half did not, so a token with
  an empty `x-oauth-scopes` header still showed an "assumed granted" chip.
- **F10** — two of three oversized files were split; `home-page.tsx` was not, and had *grown* to
  1739 lines during the pass.
- **G2** — the task page obeyed R16-3; the review queue still named the process gate over the
  terminal fact and still offered a force-accept the task page withheld.

Two items came back as **not defects**, which is the result that mattered most:

- **`verification`** reads as a dead table (no app query names it) and was one edit from deletion.
  better-auth writes it on every social sign-in; dropping it kills GitHub login. Now pinned by
  `migration-runner.server.test.ts`, canaried by deleting the `CREATE TABLE`.
- **`task_projections.repo`** likewise looks dead but feeds the task-detail GitHub links. Only its
  comment was stale.

"Nothing reads it" is not proof something is dead when a library or a projection consumer owns it.

Owner questions that remain owner questions (no code half was attempted, by design): **G3** was
reclassified — "the palette is unreachable on a phone" is a defect, not a preference, and was
fixed; **G4/G5/C3** were answered by rulings R16-7/R16-6/R16-5; **G6** (dev `.env` vs launch.json
data root) stays a local config choice, now documented in `.env.example`.

### Residual, recorded rather than papered over

R16-1 stops a foreign PR from being adopted; it does not un-adopt one that was bound BEFORE the
rule existed. `github-reconciler.server.ts:288` treats a discovery that matches the cached number
as an owned link and keeps its live facts — which is right in general (a task's own PR moves its
head) but means VIB-4 in the dev data root still carries merged PR #113 in its `task.md`. The
product does have a path out (the operator raises the branch-collision packet, and
`archive_task(+deleteBranch)` is the recovery), and no NEW task can be polluted; a self-heal for
pre-rule bindings would need its own rule about when Viberr is allowed to drop a PR reference it
once wrote, which is an owner decision, not hygiene.
