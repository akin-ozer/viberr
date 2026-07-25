# Pass 14 — findings ledger

## Owner rulings (AskUserQuestion, 2026-07-25)

- **R14-1 (stage eligibility):** auto-map by **stage role** — profile eligibility is
  stored/resolved against stage roles (work/review/… via `stage-roles.ts`), or
  translated id→role at deploy, so a profile lands eligible on ANY board's equivalent
  stages. Hand-editing per project stays. Covers WL-01 + UI-63 root cause; Lightweight
  Lab becomes workable again through the same mechanism.
- **R14-2 (owner packet authority, WIDER than FR37 minimum):** a task's human owner may
  resolve **any** packet on their own task (accept_completion, blocked decisions,
  redirects, dismiss), not just acceptance. Align `resolve-packet`/`applyRecommendation`
  guards + task-page UI + decisions inbox; correct the stale FR37 note in prd.md to the
  implemented-and-now-widened reality. (GV-01/04/07)
- **R14-3 (task archive):** build a real task-level archive — terminal disposition,
  hidden from board default, timeline/audit preserved, restorable, maintainer+ RBAC.
  The closed-PR guidance copy then tells the truth. (GV-02)
- **R14-4 (KB editor):** full editor cluster — open/view/edit-in-place for text docs,
  overwrite confirm + folder targeting on New document, error keeps the typed body,
  GitHub import respects the browsed folder. (KM-08/UI-59/60/61)

One row per defect/gap, with a disposition that must end the pass as one of:
`FIX` (scheduled) → `DONE` (implemented + verified) · `RULED` (owner decision recorded,
no code change or changed scope) · `NOT-A-BUG` (analysis says working as intended) ·
`INFO` (recorded fact, nothing to do). Nothing stays `OPEN` at pass end.

Sources: `docs/runtime-agents.md` (RT), `docs/kb-mcp-skills.md` (KM),
`docs/governance-delivery.md` (GV), `docs/routes-ui-reverify.md` (UI),
lead walkthrough `NOTES.md` (WL), live phase `USECASES.md` (LV).

## A. Runtime & agents (RT) — from docs/runtime-agents.md

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| RT-01 | HIGH | fresh run of an engaged-but-undeployed profile runs fully unconfined (empty denylist, full delivery grants, Codex danger-full-access); resume path of the same case locks down | OPEN |
| RT-02 | HIGH | first-ever @mention starts a fresh run without the comment text (no directive on either fresh branch of commentToAgent) | OPEN |
| RT-03 | MED | capability matrix understates Codex: execute-code-or-write-repo still listed CLAUDE_ONLY while the read-only sandbox enforces it on Codex | OPEN |
| RT-04 | MED | Codex-backed operator never mounts its declared MCP servers (Claude-only fix in pass 13) — same fact as KM-02 | OPEN |
| RT-05 | MED | prepareCodexHome auth mirror is boot-time-only; post-boot auth.json never reaches run home while probe says "available, no restart needed" | OPEN |
| RT-06 | MED | withheld use-web-search-fetch unenforced on Codex specialists though webSearchMode:"disabled" channel exists (operator already uses it) | OPEN |
| RT-07 | LOW | Codex mcp_tool_call/web_search project as empty meta lines — run panel can't show which MCP tool a Codex agent called; absent from parity disclosure | OPEN |
| RT-08 | LOW | restart between Codex operator finish and executeCodexPlan loses the coordination turn silently (invisible to both recovery passes) | OPEN |
| RT-09 | LOW | workspace reclaim boot-ordering comment is false (reclaim races the scheduled async recovery it claims to follow) | OPEN |
| RT-10 | LOW | Claude is_error results (except max_turns) settle error with no classified failure reason — loses quota/auth retry_other_backend routing | OPEN |
| RT-11 | LOW | interruptRun's projectOne mismatches grouped RunView for non-representative runs; falls through to an unrelated group's view | OPEN |
| RT-12 | LOW | stuck-packet @handles derived inconsistently (role-based vs name-based; multi-word → non-tokenizable handle) | OPEN |

## B. KB / MCP / skills (KM) — from docs/kb-mcp-skills.md

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| KM-01 | HIGH | MCP rename orphans every grant (saveMcpServer edit path never calls updateResourceReferences; KB/skill/delete paths all do) | OPEN |
| KM-02 | MED | operator org-MCP grants reach Claude-backed operators only; Codex operator gets none; parity disclosure omits it (= RT-04) | OPEN |
| KM-03 | MED | skill injection unbounded (whole SKILL.md into every run prompt; KBs have a 24k budget, skills none) | OPEN |
| KM-04 | MED | stdio MCP probe splits command on whitespace while runs parse quote-aware — quoted commands work live but show "unreachable" in Settings | OPEN |
| KM-05 | MED | later KB under the shared 24k budget can be dropped with zero signal (silent break; warn+marker suppressed in that branch) | OPEN |
| KM-06 | LOW-MED | withheld web egress on Codex specialists enforces nothing and the in-code "prompt-level on Codex" claim is false (no such prompt text) | OPEN |
| KM-07 | LOW-MED | rewriteProjects (project-deployment leg of reference rewriting) has zero test coverage | OPEN |
| KM-08 | LOW-MED | in-app KB authoring half-shipped: create-only at KB root, no open/view/edit of existing docs (readStoreDoc dead), GitHub import ignores browsed folder | OPEN |
| KM-09 | LOW | MCP rows show no used-by counts; rename/delete confirms blind for MCPs | OPEN |
| KM-10 | LOW | org AgentModal silently preserves invisible legacy grants (unmatched grants re-submitted but rendered nowhere) | OPEN |
| KM-11 | LOW | agents detail panel renders dangling resource refs as healthy chips | OPEN |
| KM-12 | LOW | buildOperatorToolkit comment claims allowedTools confines the run; it is auto-approve-only under bypassPermissions — deny lists are the real fence | OPEN |
| KM-13 | LOW | KB "N docs" counts every non-dot file while injection reads 6 text extensions — a KB of PDFs shows healthy and injects nothing | OPEN |
| KM-14 | LOW | operator template's `mcps: [viberr]` grant is decorative both directions (toolkit mounts unconditionally; resolver skips the name) but rendered as a real toggle | OPEN |
| KM-15 | LOW | viberr_agent not defensively skipped in resolveSpecialistMcpServers (unreachable via UI; DB-edit only) | OPEN |
| KM-16 | INFO | skills-lock.json is a dev-repo artifact with zero product consumers (product store = DATA_ROOT/skills) | INFO |
| KM-17 | INFO | per-KB wrapper heading (~35 chars) uncharged against the shared budget | INFO |

## C. Governance & delivery (GV) — from docs/governance-delivery.md

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| GV-01 | MED | contributor task-owner with an accept_completion recommendation is counted "waiting on you" but has no UI/API path to act (resolve-packet gates A|M with no owner exception) | OPEN |
| GV-02 | LOW-MED | closedPrBlockedReason tells humans to "archive the task" — task archive does not exist | OPEN |
| GV-03 | LOW | stale "Lightweight (todo/doing/done)" prose in live doc comments | OPEN |
| GV-04 | LOW-MED | FR37 drift inverted: owner acceptance IS implemented; prd.md:208 note + task-page role row + UI comment all still claim it isn't | OPEN |
| GV-05 | LOW | resolvePacket accept merges the real PR before the locked packet-identity re-check (external side effect committed under a stale decision; self-heals via poller) | OPEN |
| GV-06 | LOW | operatorPromptAgent's directive comment is the one comment writer skipping notifyMentionedUsers (NEW-4 gap) | OPEN |
| GV-07 | LOW | decisions inbox doc/comment vs enforcement disagree on owner recommendation authority (companion to GV-01) | OPEN |
| GV-08 | INFO | any-member can curl a governed-graph transition across a declared auto boundary the UI never offers (documented in-code as deliberate) | INFO |
| GV-09 | LOW | accepted-then-closed-externally PR: timeline note only, no notification, Complete-merge affordance vanishes silently | OPEN |
| GV-10 | MED* | replacing the delivering specialist mid-run has no live-run guard; old run reconciles delivery under the replaced profile (record confusion; verdict snapshot covers correctness) | OPEN |
| GV-11 | INFO | pass-13 deliverables verified holding on main (see doc §10) | INFO |

## D. Routes & UI (UI) — from docs/routes-ui-reverify.md

Re-verification verdict on pass-13's UI-01..58: **46 FIXED, 9 PARTIALLY-FIXED (≈14
concrete residual sub-items, itemized in the doc's still-open ledger), 1 STILL-OPEN
(UI-18 data-screen-label sweep, deferred by ruling), 2 OBSOLETE** (UI-16 defensive
branch; UI-17 premise wrong). All five HIGHs (UI-01/02/28/29/30) verified fixed by
mechanism. Pass-13's FINDINGS table simply froze at "OPEN" before the fix commits.

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| UI-59 | MED | in-app KB "New document" silently overwrites an existing same-named file (create-or-overwrite, no existence check, no confirm, same "saved" toast) | OPEN |
| UI-60 | MED | KB editor closes optimistically on Save — typed body destroyed when the server rejects (validation after setDoc(null)) | OPEN |
| UI-61 | LOW-MED | KB authoring create-only; readStoreDoc dead (= KM-08; fix as one editor cluster with UI-59/60) | OPEN |
| UI-62 | LOW | pass-13's new `note` event type missing from Activity page ACT_ICON/CSS vocabulary — renders as typeless dots | OPEN |
| UI-63 | LOW | "Add from library" shows template stage counts without intersecting the target board — contradicts the post-deploy roster (relates WL-01 root cause) | OPEN |
| UI-R | MED | partial-fix residuals batch (worst: silent all-dot-filtered upload no-op; silent backend narrowing on profile edit; second `github.com` literal; UI-52 editor warning; a11y/literal batch UI-13/15/58) | OPEN |

## E. Lead walkthrough (WL) — from NOTES.md

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| WL-01 | MED | Lightweight Lab stranded: dropped template's stage ids (`todo/doing/done`) match no profile eligibility; LL-1 blocked forever — no remap/repair path for legacy projects | OPEN (owner question) |
| WL-02 | MED | agent log viewer renders raw wire telemetry (rate_limit_event JSON, thinking_tokens spam) as timeline rows | OPEN |
| WL-03 | LOW-MED | "Needs attention" board filter matches only `blocked`; PR-divergence decision-required tasks (PST-5) don't qualify | OPEN |
| WL-04 | LOW | waiting-on counts differ across home (5, org-wide), board (4, project), agents page (6, threads) with no labeling of scope | OPEN |
| WL-05 | LOW | "Org Docs Writer" deployed profile: 18 direct capabilities vs 2–10 for all others; role label duplicates profile name — check template-library grant defaults + role field | OPEN |
| WL-06 | LOW | "1 context resources" pluralization on global profile cards | OPEN |
| WL-07 | LOW | Done/"task closed" task still offers active Run buttons in the execution profile (PST-1) | OPEN |
| WL-08 | INFO | board `?view=list` + inline search filter compose correctly; light theme clean; store browser honest about disk reality | INFO |
| WL-09 | LOW | PST-6 blocked packet's claim "no diff/PR evidence visible in task state" was overstated vs the honest GitHub card (packet-content quality, not a code bug) | OPEN (analysis) |

## F. Live phase (LV) — from USECASES.md

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| LV-01 | HIGH | `capabilities: []` still means FULL POWER at the interpretation layer — library deploy produced a "never touches app code" docs writer holding repo-write, push, PR and both verdict caps | OPEN |
| LV-02 | HIGH | acceptance skips the entire workflow graph (Triage → Done in one click) and hardcodes `validation: healthy` | OPEN |
| LV-03 | LOW | MCP tool names differ across backends (dash- vs underscore-cased; one extra tool on Claude) | OPEN |
| LV-04 | MED | a directive-less fresh mention run turns the injection guardrail against the task's own goal (request-changes verdict on a legitimate task) | OPEN |
| LV-05 | LOW-MED | review-queue subline shows a withdrawn divergence after the PR state changed | OPEN |
| LV-06 | MED | queue says "waiting on your acceptance" while the task page offers no acceptance affordance | OPEN |
| LV-07 | MED-HIGH | merge failure reported as unreachable-GitHub/credentials when the real cause is a conflicting PR; task closes accepted + "validation healthy" with the PR still open | OPEN |
| LV-08 | MED | Archive / Delete project / role radios render for a contributor and fail silently (no dialog, toast, or audit) | OPEN |
| LV-09 | MED | an orphaned MCP grant is advertised in the run prompt but exposes no tools — silent capability loss (KM-01 consequence) | OPEN |
| LV-10 | LOW-MED | `directiveRequestsDelivery` is a regex over prose — a question mentioning PRs is recorded as an attempted authority override | OPEN |
| LV-11 | LOW | the operator has no runtime identity in its snapshot and misreports which backend it ran on | OPEN |

### Original phase-3 checklist

*(includes at minimum: fresh Codex context audit for host-skill leakage; KB→Codex
provisioning consistency (PST-6 class); operator MCP on both backends; skill isolation
on both backends; MCP rename orphan repro; template-library deploy grants; RBAC denial
matrix; reviewer verdicts; secondary assignments; comment @mention notify incl. first
mention; PR merge via app, merge via gh, reject via gh)*
