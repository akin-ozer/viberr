# Pass 25 — implementation plan (prioritized)

Baseline: main `7cf113a`. Branch: `fix/pass25-discovery` (this worktree; edit HERE, not the main tree — pass-24 trap).
Full detail per item: FINDINGS.md, PARITY-CAPABILITY-AUDIT.md, BACKLOG-RECONCILE.md.
Every fix must land with a test + a live/UI or tsc/suite validation. No migrations/back-compat (allowed to break).

## Tier 1 — HIGH governance/security (verified in code by me)

- **P8** [F-P8] Shared-workspace cross-engagement contamination on Codex: a write-withheld Codex reviewer
  can write into the shared checkout; delivery `git add -A` ships it under the deliverer's identity.
  → **DESIGN CALL — asked owner** (Q-A). Also unconditional-truth fix regardless: the supporting-run prompt
  says "The tool layer blocks these" (false on Codex) — make it backend-aware. Cheapest safety: `git stash`
  + `git checkout -- .` / reset any uncommitted changes at the START of a supporting (non-delivering) run so
  a supporting run's writes never persist to the delivery. Files: `specialist-run.server.ts` (workspace prep,
  buildAnalyzePrompt:2218), `push-workspace.server.ts` (delivery add).
- **P9** [F-P9] Codex credential-less MCP pre-flight corrupts the shared `org_mcp_servers.up` row (globally
  down for a server healthy on Claude). Fix: when the Codex pre-flight fails specifically because the
  credential was withheld, do NOT write the shared `up=0` — retry the probe WITH the credential first and
  only downgrade if it also fails; OR record Codex-unavailability separately. Files:
  `specialist-mcp.server.ts:265-296`, `resources.server.ts:1750` (`markMcpServerUnreachableFromRun`).

## Tier 1b — HIGH-flagged, MEDIUM in practice, clear fixes

- **P1** [F-P1] Profile-detail `CapColumn` shows no per-backend enforcement caveat. Fix: thread
  `capabilityEnforcement(id)` + primary backend into `CapColumn`, render the editor's "advisory on Codex" /
  "inert on Codex" pill on claude-only rows when backend is Codex. `agents-page.tsx:233,808-810`.
- **P3** [F-P3] MCP `· auth: configured` is backend-blind. Fix: backend-aware caveat at list row
  (`resource-rows.tsx:250`), credential-note (`resource-modals.tsx`), and editor MCP chips
  (`create-profile-modal.tsx`) — "Claude runs only; Codex mounts unauthenticated."
- **P5** [F-P5] Codex operator default-branch read never refreshes / no staleness caveat. Fix (pick the
  cheaper, Claude-consistent path): add the same staleness caveat Claude's tool carries to the Codex prompt
  instruction (`operator-run.server.ts:2686-2695`); OR route through a fetch. Recommend caveat + note it's a
  clone-time ref.

## Tier 2 — coherence/honesty (clear fixes, mostly copy/small logic)

- **F25-1** Capability-matrix footnote "Codex operator cannot reach web" → both operators honor the grant.
  `capability-matrix-modal.tsx:272-276`. + coherence test.
- **F25-2** Archived-project rail badge counts a Review task the review-queue zeroes. Make the rail badge
  archived-aware (single source w/ the queue). `project.tsx:139-147` vs `review-queue.server.ts:118-136`. + test.
- **F25-3** `operator.definition.md:12` static SOP contradicts the dynamic scratch-dir prompt (Codex). Fix
  the static line to be posture-neutral. **Bump PRIOR_SHIPPED_HASHES with the OUTGOING hash + sync live
  docker-data copy** (pass-24 trap).
- **C5** Reviewer "no readable verdict" note still fires on a conversational @mention reply at review stage.
  Thread a per-run intent flag into `applyAgentCompletionEffects`; gate the note on it. `task-actions.server.ts:2866-2903`.
- **P2** [F-P2] Policy per-profile counts backend-blind (`MatrixProfile` drops `backends`). Add a backend
  chip / split governed-claude-only sub-count. `policy-page.tsx`, `agent-types.ts:155`.
- **P4** [F-P4] Browser persona says "take screenshots" but Codex omits image results. Add a matrix "what
  differs" bullet + branch `browserPersonaSection` on backend. `specialist-browser-mcp.server.ts:180-199`.
- **P6** [F-P6] `flag_context_conflict` Claude-only. Add equivalent to `OPERATOR_PLAN_TOOLS`/`executeCodexPlan`.
- **P7** [F-P7] Refused-action narration guaranteed on Codex, optional on Claude. Give Claude the same backstop.
- **P10** [F-P10] "Run inputs" console claims tool denial that didn't happen on Codex. Add backend caveat. `runs-helpers.ts:217`.
- **P11** [F-P11] Codex envelope re-parse ungated → can truncate a plain prose reply. Gate on `useEnvelopeSchema`. `task-actions.server.ts:2769`.
- **C8** Attachments 100-file silent truncation. Return `{entries,total}`, render "showing 100 of N". `task-attachments.server.ts:35,64`, `attachments-panel.tsx`.

## Tier 3 — silent-drop residue (C10) + UX polish (D)

- **C10.1** `notifyTaskWatchers` recipient-resolution failure silent. Surface it. `task-mutation.server.ts:144-171`.
- **C10.2** Post-run delivery reconcile status double-swallowed + ignored by callers. `workspace-delivery.server.ts:635-650`.
- **C10.3** Empty-branch cleanup throw → warn only (branch persists). `task-actions.server.ts:7296-7345`.
- **C10.4** Stuck-loop escalation fail/refuse → log only, no card. `task-actions.server.ts:1953-2033`.
- **C10.5** `.git/info/exclude` write failure → skill files could leak into PR. `skill-mount.server.ts:324-350`.
- **C10.8** Stale shipped `operator.md` divergence boot-only → surface in UI. `default-assets.server.ts:338-372`.
- **D3/D4/D5/D6** — verify + fix: board New task no-op on stage-less project; org profile empty-state "model"
  field; model-catalog fetch failure deadlocks Save; "1 profiles" pluralization.
- (C10.7 audit fail-open, C10.9 reservation-write, B2/C8-quota — see Tier 4.)

## Tier 4 — needs owner ruling (asked)
- **B2** Backend quota pre-run signal (open 3 passes). Q-B.
- **P8 approach** (Q-A).
- C10.7 (audit fail-open) + C10.9 (reservation write null) are deliberate degraded paths — likely leave.

## E-series (test hardening) — fold in where the fix touches the module; otherwise a dedicated pass.

---

# IMPLEMENTATION STATUS (end of pass 25)

Branch `fix/pass25-discovery`. tsc clean throughout. Every logic change tested.

## Implemented + tested
- **P8** (HIGH, headline): per-engagement workspace isolation. Supporting engagements run in
  `workspace/support/<profileId>/<repo>`, cloned FROM the delivering checkout (so a reviewer still sees the
  delivered branch) but isolated so their writes never reach the delivering tree / delivered PR. Fresh +
  resume + cwd + skill-mount + disclosure all scoped; delivery/evidence/operator paths stay canonical
  (untouched). Prompt claim fixed ("The tool layer blocks these" → the true isolation guarantee). **New test
  proves the isolation** (`specialist-run.server.test.ts` "P8 — per-engagement workspace isolation").
- **P9** (HIGH): Codex credential-less MCP pre-flight no longer corrupts the shared health row — re-probes
  WITH the credential before writing `up=0`; a Claude-healthy server stays healthy.
- **F-P1** (HIGH→MED): profile-detail CapColumn now shows "advisory on Codex" on claude-only rows for a
  Codex-primary profile (new `isClaudeOnlyEnforcedLabel` helper).
- **F-P3** (HIGH→MED, subagent): MCP `auth: configured` + credential note + editor now disclose the Codex
  unauthenticated-mount caveat.
- **F-P5** (HIGH→MED): Codex operator default-branch instruction now carries the staleness caveat (matches
  Claude's fallback-path disclosure).
- **F-P2** (MED, subagent): policy-page shows "some grants advisory on Codex" for a Codex-primary profile
  (MatrixProfile widened with `backends`).
- **F-P4** (MED): browser persona branches on backend (Codex screenshots don't return to the model) + matrix
  "what differs" bullet.
- **F-P6** (MED): `flag_context_conflict` added to the Codex operator plan tools (schema + zod mirror +
  handler + capability gate) — parity with Claude.
- **F-P10** (MED): run-inputs console says "advisory on this Codex run" instead of a flat "denied" for the
  claude-only tool deny list.
- **F-P11** (LOW): Codex reply JSON-envelope re-parse gated on `envelopeRequested` (fresh + recovery-safe) so
  a plain developer's prose reply is never truncated.
- **F25-1** (MED): capability-matrix footnote — both operators honor the web grant (was "Codex cannot").
- **F25-2** (MED): archived-project rail badge zeroed to match the review-queue count (+ reasoning).
- **F25-3** (MED): operator.definition.md SOP made posture-neutral (no longer contradicts the B-1 scratch-dir
  prompt); PRIOR_SHIPPED_HASHES bumped with the outgoing hash.
- **C5** (MED): reviewer no-verdict note now also gated on `fromHumanDirective` — never fires on a
  conversational @mention that merely lands at the review stage.
- **C8** (MED, subagent + my loader wiring): attachments panel now discloses the 100-item cap
  ("showing N of TOTAL") via a new `countTaskAttachments` + threaded `total` prop.
- **C10.3** (LOW): empty-branch cleanup throw now leaves a timeline note (was warn-only).
- **C10.4** (LOW): a stuck-loop escalation that can't open its packet now leaves a timeline note (was log-only).

## Already fixed on main (verified, not new work)
- **D3** (board New-task no-op), **D4** (org profile "model" empty-state), **D5** (model-catalog Save
  deadlock), **D6** ("1 profiles" pluralization). Confirmed present with pass-23 comments; no change needed.

## Intentionally recorded, not implemented (rationale)
- **F-P7** (MED): Claude refused-action narration backstop. **Architecturally mitigated** — Claude's model
  sees each tool denial INLINE in its transcript and its persona instructs it to narrate; Codex's server
  backstop (`narrateRefusedActions`) exists precisely because its plan executes POST-turn where the model
  can't see denials. A Claude-side backstop means instrumenting the operator run to accumulate denied toolkit
  outcomes + post-turn check — disproportionate to a narrow, already-mitigated MEDIUM. Owner call if wanted.
- **C10.1** (LOW, subagent): `notifyTaskWatchers` fail-open — kept fail-open (documented); a real surface
  needs a caller-side change. Deliberate degraded path.
- **C10.2** (LOW): post-run delivery reconcile status swallowed — it is a best-effort post-run reconcile the
  5-min reconcile-poller re-runs anyway; the swallow never loses durable state. Left as-is.
- **C10.5** (LOW, subagent): `.git/info/exclude` write failure — WARN reworded to name the leak risk; a
  `SkillMount`-flag follow-up is possible but out of scope. (Note: P8 isolation already means a SUPPORTING
  run's stray files can't ship; the residual risk is a delivering run's own exclude write.)
- **C10.8** (LOW): stale shipped `operator.md` divergence is a boot-console WARN; a new Instance-settings
  banner is disproportionate to a self-healing (PRIOR_SHIPPED_HASHES) boot path. Left as boot warn.
- **B2** (MED): backend quota pre-run signal — **owner ruled leave-as-is** (Q-B).
