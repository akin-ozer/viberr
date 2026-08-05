# AGENTS-RUNTIME — Viberr current state (pass 18)

How AI runs are spawned, confined, and delivered. Two run kinds share one uniform
machinery (generic-agents G1): the **operator** (coordination) and **specialists**
(every non-operator engaged agent — deliverer and reviewers). Anchors current to
`pass18/product-fixes`.

Key files: `app/server/tasks/specialist-run.server.ts` (specialist runs),
`app/server/runtimes/operator-run.server.ts` (operator turn engine),
`app/server/runtimes/{claude,codex}-runtime.server.ts` (adapters),
`app/server/tasks/{agent,operator}-toolkit.server.ts` (in-process tool servers),
`app/server/tasks/operator-actions.server.ts` (operator gates),
`app/server/tasks/specialist-tool-policy.ts` (capability→tool confinement).

---

## 1. Spawning a specialist run — `startAgentRun` (`specialist-run.server.ts:589`)

One path for deliverer AND reviewer (the list an agent sits in no longer changes
behavior — capability grants do). Flow:

1. Read the task file (`existing`), find this `engagement` and whether
   `delivers` (:632).
2. Resolve the deployed profile: `resolveDeployedSpecialist(ctx, slug, profileId)`
   (:223) → `ResolvedSpecialist` with `name`, `skills`, `kb`, `mcps`,
   `capabilities`. Its resources come from `effectiveProfileView` (the deployment
   override else the org template).
3. Set the run's `kb`/`skills`/`mcpNames`/`disallowedTools` from that resolved
   profile (:688-717). `disallowedTools = resolveSpecialistDisallowedTools(capabilities)`.
4. **Stage-eligibility assert** at the run boundary (:762-768).
5. **R18-1 reviewer-KB inheritance** (:770-791, below).
6. Build the persona: `buildSpecialistPersona({profileId, skills, kb, mcps, …})`
   (:800), which injects skill/KB bodies as system-prompt TEXT (:1159).
7. Clone the repo (`cloneRepo`, :1757) if the project has a repo and the backend
   is real — this is where **R18-3 catalog strip** runs.
8. Start the run via `run-service.server.ts` → the backend adapter; the fake
   runtime substitutes here in tests (`installFakeRuntime`).

Resume path (`@mention` / resumed review): `resolveResumeConfinement` (:1508)
rebuilds the persona and applies the SAME R18-1 union (:1574-1590 parity edit).

---

## 2. Capability policy → tool confinement (`specialist-tool-policy.ts`)

`resolveSpecialistDisallowedTools(capabilities)` (:151) maps withheld grants to a
Claude tool denylist. `resolveDeliveryPermissions` (:194) resolves the delivery
headline + scoped grants. `resolveUndeployedDisallowedTools` (:176) is the
fallback for an undeployed profile (withheld confinement — P14-RT-01).

**Claude adapter** (`claude-runtime.server.ts`): `BASE_DENIED_BUILTINS` (:233)
denies `Skill` (Viberr injects skills as prompt text, so bundled SDK skills are
uninvokable — the honest limit at :532-540), `Task` (no ungoverned subagents),
and web tools when web egress is withheld. The `query()` options block (:498-549)
sets the SDK isolation trio + R18-3 MCP strict flag:

- `settingSources: []` (:541) — drop host `settings.json` tiers + repo CLAUDE.md.
- `skills: []` (:542) — context filter for the Skill listing.
- `plugins: []` (:543) — zero local plugins (F13 channel).
- `strictMcpConfig: true` (:548) — **R18-3**: only Viberr-passed `mcpServers`
  reach the run; a repo `.mcp.json`, user MCP config, and plugin MCP are ignored.
- `permissionMode: "bypassPermissions"` for autonomous server-spawned runs (:519).

**Codex adapter** (`codex-runtime.server.ts`): the parallel governance —
`project_doc_max_bytes: 0` (drops repo `AGENTS.md`), `skills.bundled.enabled:
false`, `webSearchMode: "disabled"` when web egress off, `plugins/hooks/apps:
false`, and host isolation via `CODEX_HOME` (`codex-config.server.ts` — the
pass-13 fix). Codex has no `.claude` concept, so R18-3's strip is a no-op for it.

---

## 3. Skill / KB / MCP injection as system-prompt context

`buildSpecialistPersona` (`specialist-run.server.ts:1159`) assembles the persona:

- **Skills**: `readSkillBodies(input.skills, dataRoot)` (:1192) — reads each
  GRANTED skill's `store://skills/<name>/` body and injects it as text
  (`app/server/files/skill-body.server.ts`). Ungranted skills never appear.
- **KB**: `readKbBodies(input.kb, dataRoot, KB_INJECTION_BUDGET)` (:1205) — reads
  each granted KB folder (`app/server/files/kb-injection.server.ts`), tolerant of
  a missing/renamed/empty folder (injects nothing + a "did NOT reach this run"
  marker). One shared byte budget across all KBs.
- **MCP**: the run mounts only the granted external MCP servers
  (`mcpServersFor(db, mcpNames)`, :799) plus the in-process `viberr_agent`
  toolkit; the persona announces what actually mounted (P14-LV-09).

### 3.1 R18-1 — reviewer inherits the delivering engagement's KBs

Fix `97131bd`. A reviewer with `kb: []` used to judge against different
conventions than the deliverer and returned a false `request_changes` (F18-11,
live-caught). Now, for a non-delivering run only (`specialist-run.server.ts:782-791`):

```
if (!delivers) {
  kb = withDeliveringKb(kb, () =>
    deliveringKbGrants(existing.parsed.frontmatter, engagement.profileId,
      (profileId) => resolveDeployedSpecialist(ctx, slug, profileId).kb));
}
```

- `deliveringKbGrants(frontmatter, reviewerProfileId, resolveKb)` (:265-277) —
  returns the delivering engagement's KBs via `deliveringEngagement(fm)`, or `[]`
  when there is no deliverer / the deliverer IS this profile / the deliverer is
  undeployed (resolve throws → caught).
- `withDeliveringKb(own, resolveExtras)` (:284-294) — reviewer's own KBs first,
  the deliverer's extras appended, **deduped** so a shared KB is injected (and
  charges the shared budget) once.

The delivering run and the operator run (separate `buildOperatorSystemPrompt`
path) are untouched.

### 3.2 R18-3 — strip the ungoverned repo `.claude` catalog

Fix `e274134`. `stripUngovernedRepoCatalog(repoDir)`
(`specialist-run.server.ts:1728-1755`) is called before BOTH `cloneRepo` return
points (reuse and fresh-clone, :1797 and :1816), so every real-backend run's
working tree loses its `.claude`. Because `.claude` is git-TRACKED and delivery
auto-commits with `git add -A`, a plain `rm -rf` would ship a `.claude` DELETION
into the review PR — so the helper first marks every tracked `.claude` path
`git update-index --skip-worktree` (:1739-1743), then `rmSync`s the dir (:1754).
Git then treats the absent files as unchanged; the committed tree keeps `.claude`
from the index. A skip-worktree failure is non-fatal (logged; the catalog is
still stripped). Documented limitation: a task to edit the repo's own `.claude`
can't deliver those edits — the intended governance posture. Claude's user-level
catalog is separately governed by `CLAUDE_CONFIG_DIR` isolation in production
(`claude-config.server.ts`); `strictMcpConfig` closes the MCP channel (§2).

---

## 4. The agent toolkits (in-process MCP servers)

- **`viberr_agent`** (`agent-toolkit.server.ts:374-380`) — the specialist's
  capability-gated toolkit: `post_comment` (gated on `comment-on-task`),
  `ask_human` (opens a question packet, gated on `ask-human`, stamps `askedBy`),
  `report_outcome` (stages the verdict/completion envelope, gated on
  `report-validation-verdict` + `attach-evidence-references`). The final report
  always posts via the completion pipeline regardless of `comment-on-task`.
- **Operator toolkit** (`operator-toolkit.server.ts`) — `post_comment`,
  `prompt_agent` (engage/run a specialist, `delivers` flag), `deliver_for_review`,
  `transition_stage`, `accept_completion`, `resolve_decision_packet`, etc. Each
  tool gates on the operator's capability grant + autonomy (`gate`/`deliverGate`,
  `operator-actions.server.ts:272-313`).

---

## 5. Delivery pipeline (server-owned push + PR)

Agents never push; the SERVER performs delivery. `operatorDeliverForReview`
(`operator-actions.server.ts:1762`) gates on `deliver-review-pr` (:1768) — under
supervised autonomy `deliverGate` returns `recommend` and posts a recommendation
card instead of pushing (:1789-1803); under full/direct it calls `performDelivery`
with `operatorAuthorized: true` (:1809). Human paths: `manualDeliverForReview`
(`task-actions.server.ts:3621`, the button) and `applyRecommendation`'s delivery
branch (:5479).

`performDelivery` (`task-actions.server.ts:3332`) → `pushWorkspaceBranch`
(`github/push-workspace.server.ts`, the `git add -A` commit) → `openTaskPr`
(`github/pr-open.server.ts`, opens the review PR, writes the "Opened PR" github
timeline event, mints the `workRevision`). It no-ops on a live PR (idempotent).
On success it clears a stale `noChanges` flag (R17-2, :3516-3521).

### 5.1 R18-2 — full-autonomy re-queue after delivery

Fix `e07abc0`. Opening a review PR is delivery, NOT a stage transition, so the
per-transition operator re-trigger and the stranded-operator backstop never fired
— an autonomous task sat `waiting:human` with empty `recommendations`, no packet,
no card (F18-10, live-caught on LAB-1). Now, inside `performDelivery`'s
`result.status === "ok"` branch (`task-actions.server.ts:3533-3548`):

```
if (result.created) {                       // NEWLY opened PR only (no loop on reuse)
  const autonomy = ctx.operatorRun?.autonomy
    ?? resolveOperatorAuthority(ctx, projectSlug).autonomy;
  if (autonomy === "full") {
    void autoInvokeOperator(db, ctx, projectSlug, taskKey, "delivered",
      nextTransitionChainDepth(ctx));
  }
}
```

- Fire-and-forget (`void`), mirroring the transition re-trigger. Gated on a
  **newly created** PR + **full** autonomy. Supervised is deliberately left to
  the human (the "Opened PR" event drives the next move; NOT a strand).
- `autoInvokeOperator` (:687-728, trigger union widened to include `"delivered"`
  at :692) no-ops when no operator is deployed and threads
  `nextTransitionChainDepth(ctx)` so the operator-authored chain shares
  `OPERATOR_TRANSITION_CHAIN_CAP` (=8) — no runaway.
- The re-queued run is idempotent: `operatorDeliverForReview` no-ops on the live
  PR, and the queued trigger is mutually exclusive with the stranded-resume
  backstop (`releaseOperatorLease` fires the queue then returns).

---

## 6. Operator triggers (`operator-run.server.ts`)

`RunOperatorInput.trigger` union (:98-105): `create`, `transition`,
`agent-reply`, `pr-diverged`, **`delivered`** (new), `scheduled`, `manual`.
`OperatorTrigger = NonNullable<...>` (:2049). Single-flight lease per task;
concurrent triggers are queued newest-wins and fire on lease release (:285,
:712). `operatorTurnInstruction` (:2102) computes the one-next-step instruction;
the `delivered` branch (:2179-2192) tells the operator delivery is DONE — engage a
verdict-capable reviewer / accept / transition, and stop if a reviewer run is
already in flight. The **triage quality gate** `triageQualityGate(snapshot)`
(:2085) blocks Triage→Ready until a vague goal survives scoping (F15-14;
placeholder `DEFAULT_GOAL`, `task-actions.server.ts:421`).

---

## 7. Guardrails (`comment-guardrails.server.ts`)

Real write-time enforcement on the CANONICAL record (owner ruling Q3):
`isMeaninglessComment` (:28), `enforceOperatorBrevity`
(`OPERATOR_BREVITY_MAX_CHARS = 1000`, :36-51), `separateEvidence` (trims raw
fenced dumps to `EVIDENCE_MAX_FENCE_LINES = 12`, pointing at run logs, :56-77).
`applyCommentGuardrails` (:113) runs them and REPORTS what it did (`CommentTrim`).
Injection guardrails are exercised live (a Codex run refused a credential-
exfiltration injection this pass). The evidence-separation guardrail complements
the `evidence:` timeline rows (DOMAIN-MODEL.md §2.7): the rows carry the citation
the guardrail leaves behind.

---

## 8. Scheduled re-runs (`schedule.server.ts`)

`scheduleTaskAction` (:113) writes a `schedules[]` entry into the task file
(canonical, survives rebuild); `startScheduleRunner(db)` (:475, started at boot)
polls `task_projections.schedules_json` for due entries and fires
`fireDueSchedules` (:255) → an operator run (backend-agnostic, works for Claude
AND Codex). Lifecycle `pending → claimed → fired|failed|cancelled`
(DOMAIN-MODEL.md §2.5). `cancelScheduledAction` (:171) is the human withdrawal;
archiving a task cancels its schedule (R14-3, `firedAt` null).

---

## 9. Run recovery + projection

`run-recovery.server.ts` (`finalizeOrphanedRuns`, `recoverUnreactedAgentRuns`,
`recoverStrandedOperatorPlans`) reconciles runs interrupted by a restart;
`run-projection.server.ts` projects `agent_runs` + `run_log_lines`;
`session-export.server.ts` builds the downloadable transcript installer
(`/resources/session-export`). Run cost/turns/duration surface on the task
timeline.

---

## 10. Pass-18 delta summary

| Change | Commit | Files |
| --- | --- | --- |
| R18-1 reviewer inherits deliverer KBs | `97131bd` | specialist-run.server.ts:265-294, 782-791, 1574-1590 |
| R18-3 strip repo `.claude` + strict MCP | `e274134` | specialist-run.server.ts:1728-1755, 1797, 1816; claude-runtime.server.ts:548 |
| R18-2 full-autonomy delivery re-queue | `e07abc0` | task-actions.server.ts:3533-3548, 692; operator-run.server.ts:103, 2179-2192 |
| R18-4 (KEEP) branch-collision stays a human-gated packet | — | no code change (intentional) |

R18-4 rejected the "always force-reset the remote task branch at execution start"
option — the collision packet + human resolve is an intentional safety checkpoint,
so there is deliberately no code change.
