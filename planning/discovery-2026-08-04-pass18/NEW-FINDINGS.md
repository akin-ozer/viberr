# Pass 18 — NEW findings (adversarial intent-vs-code audit)

> **DISPOSITION (all implemented on `pass18/product-fixes`, 2026-08-05).** Every
> finding below is fixed, canaried (fix neutered → test fails → restored), and
> covered by a test; full suite 2855 green + tsc clean.
>
> - **G1** (MED) — `operatorPostComment` now returns the real guardrail outcome
>   (`noop` + honest message on a drop, wiring in the previously-dead
>   `applyCommentGuardrails`/`commentOutcomeMessage`) and records
>   `task.comment.dropped`; fixes the SDK honesty gap AND the Codex silent strand.
> - **G2** (MED) — `listTaskDiagnostics` carries a server-computed `readinessEffect`
>   from `readinessEffectOf`; the panel renders it via the hero's `ReadinessPill`.
> - **G3** (MED) — notifications filter is `role="group"` + `aria-pressed` (UI-58).
> - **G4** (LOW) — login hero drops the banned "governed" (design L182); the
>   copy-ban lint (F18-14) no longer allowlists it.
> - **G5** (LOW) — `aria-pressed` on the six remaining `mini-seg` toggles.
> - **G6** (LOW) — no-plan escalation inspects the `operatorOpenPacket` result and
>   falls back to a `note` when packet-gen is withheld (no more silent strand).
> - **G7** (LOW) — `postAgentReplyComment` runs the `compression-threshold` pass.
> - **G8** (LOW) — continuity reset is a warning-toned `continuity` typed event
>   (amber), not a neutral `note`. The Continuity Recovery Panel + board-CARD cue
>   (needs a task-schema continuity field) remain D18, as scoped below.

Second-pass audit against the source-of-intent documents (PRD, architecture,
ux-design-specification, design/prd, design/CONVERSATION-SUMMARY, decisions.md),
hunting for gaps NOT already in `FINDINGS.md` (F18-1..F18-13, R18-1..R18-4) or the
pass-17 known-carried questions (D16 webhooks, D17 NFR measurement, D18 continuity
panel, D19 board keyboard traversal).

Every finding below was verified in code (file:line) before recording; candidates
that did not survive verification are listed under "Investigated — no defect".

**Tally: 3 MED, 5 LOW. No HIGH.** The tree is heavily hardened; RBAC/capability,
secret isolation, idempotency, and the anti-noise guardrails' *enforcement* are all
sound. The new findings are honesty/coherence/a11y defects, concentrated in three
places: the operator-comment outcome, the diagnostics panel's state color, and
segmented-control ARIA.

Method note: three independent adversarial sub-audits (operator/guardrails, RBAC/
capability, a11y/UX-coherence) plus direct verification of secret isolation, SSE
reconnect, R16-6 visibility, the design rejection-list, and the copy ban.

---

## MED

### G1 — Operator `post_comment` reports success when the guardrail actually dropped the comment; the honest-outcome fix is dead code; Codex path can strand silently
**Intent:** FR26 (operator narration must be truthful + actionable); the "never
strand `waiting:human` with no packet" invariant (R-A / R18-2 spirit); the explicit
B-FD8 intent recorded in `comment-guardrails.server.ts`.

**Evidence:**
- `app/server/tasks/operator-actions.server.ts:1129` — `operatorPostComment` returns
  `{ outcome: "done", message: "Comment posted to the timeline." }` **unconditionally**.
- `writeOperatorComment` (`operator-actions.server.ts:364`) is `Promise<void>` and
  silently early-returns on two guardrail drops: meaningful-comment (`:382-387`) and
  no-duplicate-summary suppress (`:411-421`, `:444`). The `@mention` fan-out
  (`notifyMentionedUsers`, `:448`) runs *after* both returns, so a dropped comment
  also notifies **nobody**.
- The functions written to fix exactly this — `applyCommentGuardrails` /
  `commentOutcomeMessage` (`app/server/tasks/comment-guardrails.server.ts:113-170`),
  docstring: *"a dropped or deduped comment came back to the model as 'Comment posted
  to the timeline.'"* — are referenced ONLY in their co-located test. Grep across `app/`
  outside the test finds zero production callers: **dead code.**
- The Codex plan executor's `record()` captures only `denied`/`noop`
  (`app/server/runtimes/operator-run.server.ts:1371-1379`), so a `post_comment` that
  returned `done` on a *dropped* comment is invisible to `narrateRefusedActions` too.

**Scenario:** A human @-asks the operator a question. On a re-run the operator answers
with text matching its prior comment (or short chatter); the guardrail drops it; the
human is never notified; nothing lands on the timeline — but the model is told
`[done] Comment posted to the timeline.` and stops, believing it answered. On Codex, a
plan whose only action was that dropped comment then settles the task to
`waiting:human` with no comment, packet, or note: a silent strand.

**Fix:** Wire the existing `applyCommentGuardrails`/`commentOutcomeMessage` into
`writeOperatorComment`/`operatorPostComment` so the tool result reflects the real
outcome (`dropped`/`duplicate`/`trimmed`) and records the `COMMENT_DROPPED_AUDIT_ACTION`
the operator path currently omits; on a full drop with nothing else in the turn, fall
back to a `note` so the human sees why the operator went quiet.

### G2 — Diagnostics panel paints inconsistency-risk findings with the crimson "blocked" color and ignores `hardStop` — a state-semantics collapse (the goal's #1 priority)
**Intent:** ux-design-specification.md §State Semantics — *"Input gaps, inconsistency
risk, blocked conditions … must not collapse into a single generic error treatment"*
and *"Every state must mean the same thing everywhere it appears."*

**Evidence:**
- `app/features/task-detail/task-main-sections.tsx:33-34` —
  `kind = severity === "error" ? "blocked" : severity === "warning" ? "input" : "neutral"`,
  rendered at `:56-57` as `<Pill kind={kind(d.severity)}>{d.severity}</Pill>`.
- Canonical policy `app/server/interpretation/diagnostics-policy.server.ts`
  (`readinessEffectOf`, ~:28-40): `hardStop → blocked`, `error →
  inconsistency_risk_detected`, `warning → input_required`.
- `app/ui/pill.tsx:61`: `inconsistency_risk_detected → kind:"risk"` (amber);
  `blocked → kind:"blocked"` (crimson).

**Scenario:** A `task.md` with a soft (non-hardStop) `error` diagnostic drives readiness
to `inconsistency_risk_detected`, so the TaskHero at the top shows the amber
**"inconsistency risk"** pill (`task-main-sections.tsx:158`), while the Diagnostics
panel a few rows below paints the *same finding* crimson **"error"**. One page, one
finding, two contradictory color semantics — a supervisor can't tell "review before
continuing" (amber) from "failure" (crimson). Separately, the panel keys on `severity`
only and ignores `hardStop` — the one condition policy actually colors `blocked` — so a
hardStop-with-`warning`-severity diagnostic shows amber while the task reads `blocked`.

**Fix:** Color and label the panel from the policy's own `readinessEffectOf`
(hardStop→blocked, error→risk, warning→input, else neutral) and use the readiness state
word, not the raw `severity` string, so the panel speaks the same language as the hero.

### G3 — Notifications All/Unread filter is a malformed `radiogroup` and conveys the active filter by color/class alone
**Intent:** WCAG 2.2 AA (PRD/UX-spec accessibility baseline) — 4.1.2 Name/Role/Value
and 1.4.1 Use of Color; spec §Navigation *"Current location should be visible without
relying on color alone."*

**Evidence:** `app/features/notifications/notifications-page.tsx:230-250` —
`<div className="mini-seg" role="radiogroup" aria-label="Filter notifications">` whose
children are plain `<button className={f === id ? "on" : ""}>` with **no** `role="radio"`,
**no** `aria-checked`, **no** `aria-pressed`. The active filter is signaled only by the
`on` CSS class. This is the exact defect the activity page already fixed under **UI-58**
(`app/features/activity/activity-page.tsx:312-327`, switched to `role="group"` +
`aria-pressed`); every other segmented control (board `board-page.tsx:781-796`, home
`home-sections.tsx:216-226`, timeline `timeline.tsx:330-331`, agents
`agents-page.tsx:1183-1193`) carries the state attribute. Notifications is the miss.

**Scenario:** A screen-reader/keyboard user on the Notifications overlay hears
"All, button" / "Unread, button" with no indication which is active, and the
`radiogroup` promises radio-arrow navigation that isn't wired.

**Fix:** Mirror the activity page — `role="group"` + `aria-pressed={f === id}` on each
button (or real `role="radio"` + `aria-checked`).

---

## LOW

### G4 — The banned word "govern/governance" appears in rendered UI copy
**Intent:** design/CONVERSATION-SUMMARY.md hard copy ban — *"'govern/governor/governance'
is BANNED — use Maintainer / Permissions / 'managed'"*; the login tagline had "governed"
explicitly removed at design time.

**Evidence (rendered text nodes, not comments):**
- `app/routes/login.tsx:428` — `<h2>Governed AI delivery for small teams</h2>`
- `app/routes/login.tsx:435` — `<li>Task-centered board with a governed operator</li>`
- `app/features/policy/policy-page.tsx:420` — "Off the governed path:"
- `app/features/policy/policy-page.tsx:504` — "… below govern **human** actors;"
- `app/features/task-detail/timeline.tsx:401` — empty state "No governance events in the
  loaded history — switch to All, or load older events."
(`GOVERNED_TEMPLATE.label` "Governed · 5 stages" is server-only with a single template
and is never rendered — excluded.)

**Scenario:** The login first-impression surface, the Policy config surface, and a core
task-timeline empty state all use the banned term, contradicting the product's own copy
discipline. Low functional impact; a coherence/consistency regression on the goal's
stated priority.

**Fix:** Replace with the sanctioned vocabulary — e.g. "Managed AI delivery" /
"the operator", "Off the managed path", "No workflow events in the loaded history".

### G5 — Segmented-toggle ARIA cluster: dialog and settings toggles lack `aria-pressed`/role (same class as G3)
**Intent:** WCAG 2.2 AA 1.4.1 / 4.1.2.

**Evidence:** `mini-seg` + `className={x === y ? "on" : ""}` with no state attribute:
- `app/features/org-settings/resource-modals.tsx:60-62` (refresh interval, inside the
  resource dialog) and `:165-169` (transport).
- `app/features/org-settings/users-panel.tsx:303-307`, `:438-442`, `:675-685` (role
  toggles) — the same file's IdP toggles at `:173/195/217` **do** carry `aria-pressed`,
  proving the role toggles are an oversight, not a convention.
- `app/features/profile/profile-page.tsx:392`.

**Fix:** Add `aria-pressed` (or `role="radio"`+`aria-checked`) on each, one line apiece.

### G6 — Codex "no usable plan" escalation strands silently when `generate-packets` is withheld
**Intent:** FR26 anti-strand — the code's own promise (`operator-run.server.ts:1312-1314`:
*"a HUMAN-VISIBLE failure, not a silent no-op … nothing else covers an operator's own
run"*).

**Evidence:** On an empty/unparseable Codex plan, `operator-run.server.ts:1311-1341`
calls `operatorOpenPacket(...).catch(...)`. But `operatorOpenPacket` returns
`{ outcome: "denied" }` **without throwing** when the gate denies it
(`operator-actions.server.ts:649-653`), and `generate-packets` is a real withholdable
operator capability (`app/shared/capabilities.ts:37`, enforced `:182`). The returned
`denied` is discarded and `.catch` only catches throws — so no packet, no note, only a
server-side `logger.warn`; the task settles to `waiting:human` with no signal.

**Scenario:** A Codex operator deployed with `generate-packets` off/human emits an
unparseable turn; the task sits "waiting on you" with no packet or explanation.

**Fix:** Inspect the `operatorOpenPacket` result; if it did not open a packet
(denied/noop), fall back to a direct `note` write (as `narrateRefusedActions` does).

### G7 — `compression-threshold` guardrail never fires on a pure agent-reply flood
**Intent:** the guardrail's stated purpose (`timeline-compaction.server.ts:22-27`, B-FD9:
*"an agent-heavy timeline — the flood case anti-noise exists for"*).

**Evidence:** `compactTimelineEvents` is invoked only from the operator-comment path
(`operator-actions.server.ts:429-442`) and the human-comment path
(`task-actions.server.ts:822-835`). The agent-reply writer `postAgentReplyComment`
(`task-actions.server.ts:1544-1546`) unshifts the event and never calls it; typed-event
writes don't either.

**Scenario:** A run of agent replies accretes without ever triggering a compaction pass,
even though B-FD9 made those replies foldable. Practically bounded (operators comment
often), hence LOW.

**Fix:** Run the same `compactOn`/`compactAt` pass inside `postAgentReplyComment`.

### G8 — Runtime-continuity loss surfaces only as a neutral timeline `note`; no board / header / execution-strip signal (extends known D18)
**Intent:** PRD Journey 4 (Murat) — *"Continuity warning appears on task or board"*;
ux-design-specification.md Execution Truth Strip state *"degraded continuity"* and the
State-Semantics non-collapse rule.

**Evidence:** `app/server/runtimes/run-service.server.ts:611-616` writes the
continuity-lost event as `type: "note"` (a NEUTRAL lifecycle class per
`app/features/task-detail/event-meta.ts`), actor system `runtime-continuity`. It causes
no readiness change, no board-card cue, and no Execution-Truth-Strip state (the task
schema has no continuity field). The re-anchor mechanism itself (FR22/NFR12/NFR17) is
correct — probe-before-resume, fresh session, task.md re-anchor — but the *surface* is
only a neutral note buried mid-timeline.

**New angle vs D18:** not merely "the panel is unbuilt" — the underlying event is
classified NEUTRAL, so even a scanning supervisor gets no cue and Journey 4's entry
point ("warning appears on task or board") has no data to key off. The a11y/UX sub-audit
judged the panel absence itself to be pure D18; this records the event-classification
angle for the owner to weigh.

**Fix:** Elevate the continuity-reset event to a warning-toned typed event and add a
board/header cue; the full Continuity Recovery Panel remains D18.

---

## Investigated — NO defect (clean bills this pass)

- **RBAC / capability (full adversarial trace):** No new hole. ALWAYS_HUMAN
  (merge / transition-to-Done / change-policy) is structurally unreachable — no such
  tool exists in either toolkit, and agents hold **no** GitHub credential (GIT_ASKPASS
  only), so an agent's Bash cannot curl the merge API. Role tiers match
  `app/shared/rbac.ts` at every action handler; R15-4 members-only is re-gated on every
  project loader/action AND the resource routes (run-log, session-export, SSE per-scope,
  search); owner authority (R14-2/R15-3) clears only the outer decision gate and never
  over-grants (each inner mutation re-checks its tier in `resolvePacket`/`applyRecommendation`).
- **NFR7 secret isolation:** `git-clone-auth.server.ts` keeps the PAT out of argv, URL,
  and persisted git config (GIT_ASKPASS + reset credential helper); `run-sink` redacts
  token shapes on every emitted line; both runtime adapters classify failures in-memory
  BEFORE redaction and never write raw stderr to the timeline.
- **FR39 scheduled re-runs:** terminal-stage guard at both create and fire; RBAC via
  `requireRunAgents`; cancellable.
- **FR27 autonomy vs completion-for-acceptance:** `completion-for-acceptance` is
  `promotable:false`; the gate refuses `recommend→direct` promotion, so raising autonomy
  alone never confers acceptance. Correct.
- **FR22/NFR17 continuity mechanism:** three-valued probe; missing history re-anchors on
  a fresh canonical session, neither swallowed nor crashing. (UX surfacing = G8/D18.)
- **Packet shape (FR26):** packets cannot be emitted empty/malformed — validated title +
  ≥1 option + known kinds, with a non-empty default fallback.
- **Anti-noise guardrails (enforcement):** all five have real teeth on the operator path;
  agent replies enforce meaningful-comment + evidence-separation. The only gaps are the
  honesty gap (G1) and the agent-flood trigger gap (G7).
- **R16-6 "Done means two things":** board-query preserves `pr.state:"accepted"`; the
  board card renders the "merge pending" pill; the review-queue clause is moot (accepted
  tasks leave the review stage).
- **SSE reliability:** `use-live-updates.ts` auto-reconnects on bounded exponential
  backoff plus a manual retry affordance — the architecture's "tolerate reconnects" holds.
- **Design rejection-list respected:** no "Secrets · Isolated" Permissions row, no
  persistent "Live"/SSE indicator (only an honest degraded "live updates paused — retry"
  banner), no addressee Team/Specialist toggle; FR24 board `ValidationPill` present.
- **Feedback honesty:** both central toast paths pass `kind:"error"` explicitly; no
  success-tick-on-failure path found. Decision Packet a11y is solid (roving radiogroup,
  aria-checked/-disabled, aria-describedby refusal). Icon-only buttons all have
  accessible names. Empty states across board/review/timeline/agents/notifications
  explain what's absent and the next action. Notification pref categories map 1:1 to
  kinds (ruling 13).
