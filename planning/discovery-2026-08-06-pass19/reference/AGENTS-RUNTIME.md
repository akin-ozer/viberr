# AGENTS-RUNTIME — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

How AI runs are spawned, confined, and delivered. Two run kinds share one uniform
machinery (generic-agents G1): the **operator** (coordination) and **specialists**
(every non-operator engaged agent — deliverer and reviewers). All line anchors
re-verified against `main @65063b8`.

Key files: `app/server/tasks/specialist-run.server.ts` (specialist runs),
`app/server/runtimes/operator-run.server.ts` (operator turn engine),
`app/server/runtimes/{claude,codex}-runtime.server.ts` (adapters),
**`app/server/runtimes/skill-mount.server.ts`** (workspace `.claude` owner —
strip + native skill mount, R18-3 + R18-5),
`app/server/tasks/{agent,operator}-toolkit.server.ts` (in-process tool servers),
`app/server/tasks/operator-actions.server.ts` (operator gates),
`app/server/tasks/specialist-tool-policy.ts` (capability→tool confinement).

---

## 1. Spawning a specialist run — `startAgentRun` (`specialist-run.server.ts:633`)

One path for deliverer AND reviewer (the list an agent sits in no longer changes
behavior — capability grants do). Flow:

1. Read the task file (`existing`), find this `engagement` and whether
   `delivers` (:676).
2. Resolve the deployed profile: `resolveDeployedSpecialist(ctx, slug, profileId)`
   (:227) → `ResolvedSpecialist` with `name`, `skills`, `kb`, `mcps`,
   `capabilities`. Its resources come from `effectiveProfileView` (the deployment
   override else the org template).
3. Set the run's `kb`/`skills`/`mcpNames`/`disallowedTools` from that resolved
   profile (:731-750). `disallowedTools = resolveSpecialistDisallowedTools(capabilities)`.
4. **Stage-eligibility assert** at the run boundary (:766-773).
5. **R18-1 reviewer-KB inheritance** (:775-796, below).
6. Resolve the MCP grants BEFORE the persona (`mcpServersFor`, :803) so the
   persona announces only what actually mounted (P14-LV-09).
7. Clone the repo (`cloneRepo`, :1828) if the project has a repo and the backend
   is real — the clone calls **R18-3 catalog strip** on both its return paths
   (:1868 reuse, :1887 fresh).
8. **R18-5 native skill mount** (`mountGrantedSkills`, :867-874) — Claude +
   real-backend only; returns `{mounted, skipped}`.
9. Build the persona: `buildSpecialistPersona({profileId, skills, nativeSkills,
   kb, mcps, …})` (:880-890, definition at :1188). Skills that MOUNTED are
   announced but **not** injected; the rest still ride the prompt as text (§3).
10. Start the run via `run-service.server.ts` → the backend adapter, passing
    `skills: skillMount.mounted`; the fake runtime substitutes here in tests
    (`installFakeRuntime`).

Resume path (`@mention` / resumed review): `resolveResumeConfinement` (:1627,
**now `async`** because it re-mounts) rebuilds the persona, applies the SAME
R18-1 union (:1674-1684) and re-mounts the granted skills into the surviving
clone (:1690-1697), returning `skills` alongside `disallowedTools`. Its one
production caller is `task-actions.server.ts:1217` (dynamic import) — it must
`await`.

---

## 2. Capability policy → tool confinement (`specialist-tool-policy.ts`)

`resolveSpecialistDisallowedTools(capabilities)` (:151) maps withheld grants to a
Claude tool denylist. `resolveDeliveryPermissions` (:194) resolves the delivery
headline + scoped grants. `resolveUndeployedDisallowedTools` (:176) is the
fallback for an undeployed profile (withheld confinement — P14-RT-01).

**Claude adapter** (`claude-runtime.server.ts`): `BASE_DENIED_BUILTINS` (:242-276)
denies `Skill` (conditionally — see below), the whole subagent family (`Task`,
`TaskCreate/Get/List/Output/Stop/Update`), `Workflow`, the Cron family,
`ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `PushNotification`, `SendMessage`,
`DesignSync`, `EnterWorktree`/`ExitWorktree`. Deliberately NOT denied:
`ToolSearch` (the operator loads its deferred `mcp__viberr__*` tools through it),
the coding toolset, web tools, and the `mcp__*` channel.

The `query()` options block (:556-616) has **two shapes**, decided by
`nativeSkills = nativeSkillNames(spec.skills)` (:555; helper at :289-292 —
re-filters through `isSdkSkillName` so a bad store folder name can never make
`query()` throw before start):

| Option | No mounted skill | ≥1 mounted skill |
| --- | --- | --- |
| `settingSources` (:607) | `[]` | `["project"]` (the run's own checkout only — never `user`/`local`) |
| `skills` (:608) | `[]` | `[<exact mounted names>]` |
| `managedSettings` (:609) | absent | `MANAGED_SETTINGS` (:310-312) = `claudeMdExcludes: ["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/**"]` |
| `Skill` in the denylist (:663-665) | denied | **un-denied** (the `skills` filter is the fence instead) |
| `plugins` (:610) | `[]` | `[]` |
| `strictMcpConfig` (:615) | `true` | `true` |

- **HONEST LIMIT (unchanged)**: `skills: []` does NOT give an empty skill SET —
  the SDK compiles ~16 first-party skills into its binary (docker-verified
  2026-07-18). Denying the `Skill` tool is what makes them uninvokable. A run
  that mounts granted skills relies on the `skills` allow-list instead, which
  rejects every unlisted skill (bundled ones included) at the tool boundary.
- **HONEST NOTE (new, R18-5, `claude-runtime.server.ts:294-309`)**:
  `settingSources: ['project']` is also the source that loads `CLAUDE.md` memory
  files, so it re-opens a repo-`CLAUDE.md`→system-prompt ingress that
  `settingSources: []` closed for free. `claudeMdExcludes` is the documented
  switch and is passed, but it is **NOT live-verified** (a later pass-18 doc
  commit, `b312464`, reports a live run where CLAUDE.md was not loaded as
  memory — treat that as one observation, not a proof).
- `permissionMode: "bypassPermissions"` for autonomous server-spawned runs (:573).
- `strictMcpConfig: true` — **R18-3**: only Viberr-passed `mcpServers` reach the
  run; a repo `.mcp.json`, user MCP config, and plugin MCP are ignored.

**Codex adapter** (`codex-runtime.server.ts`): the parallel governance —
`project_doc_max_bytes: 0` (drops repo `AGENTS.md`), `skills.bundled.enabled:
false`, `webSearchMode: "disabled"` when web egress off, `plugins/hooks/apps:
false`, and host isolation via `CODEX_HOME` (`codex-config.server.ts` — the
pass-13 fix). Codex has no `.claude` concept, so R18-3's strip is a no-op for it,
and **no native skills channel** — its whole skills channel stays severed
(documented at `codex-runtime.server.ts:200-215`, LV-13), so a Codex run's
granted skills keep riding the system prompt as text. This backend asymmetry is
deliberate and is the reason `nativeSkills` is a SUBSET of grants, never a switch.

**Plumbing**: `RunSpec.skills` (`adapter.server.ts:50-58`, Claude-only),
`StartRunInput.skills` (`run-service.server.ts:229-231`), and the resume input's
`skills` (:683-689, re-applied at :752 and :787 — the XS-1 fresh-vs-resume parity
class).

---

## 3. Skill / KB / MCP context — the hybrid carrier model

`buildSpecialistPersona` (`specialist-run.server.ts:1188`) assembles the persona:

- **Skills — two carriers since R18-5**. `native = skills ∩ nativeSkills`
  (:1233-1236) are announced in an "Attached skills (trusted — installed in your
  workspace)" block (:1237-1253) and their bodies are deliberately NOT injected
  (the SDK loads them on Skill invocation — progressive disclosure).
  `injectable = skills \ native` still goes through
  `readSkillBodies(injectable, dataRoot)` (:1259, `app/server/files/skill-body.server.ts`)
  as prompt TEXT under ONE shared budget (C2). The intersection is taken against
  the DECLARED grants, so a stale mount can never enable craft the profile no
  longer grants. Ungranted skills never appear either way.
- **KB**: `readKbBodies(input.kb, dataRoot, KB_INJECTION_BUDGET)` (:1272) — reads
  each granted KB folder (`app/server/files/kb-injection.server.ts`), tolerant of
  a missing/renamed/empty folder (injects nothing + a "did NOT reach this run"
  marker). One shared byte budget across all KBs. KB has **no** native carrier —
  it is always prompt text.
- **MCP**: the run mounts only the granted external MCP servers
  (`mcpServersFor(db, mcpNames)`, :803) plus the in-process `viberr_agent`
  toolkit; the persona announces what actually mounted (P14-LV-09).

### 3.1 R18-1 — reviewer inherits the delivering engagement's KBs

Fix `97131bd`; helpers RENAMED in `776e0ed`/`b0f3f99`. A reviewer with `kb: []`
used to judge against different conventions than the deliverer and returned a
false `request_changes` (F18-11, live-caught). Now, for a non-delivering run only
(`specialist-run.server.ts:787-796`):

```
if (!delivers) {
  kb = withDeliveringGrants(kb, () =>
    deliveringContextGrants(existing.parsed.frontmatter, engagement.profileId,
      (profileId) => resolveDeployedSpecialist(ctx, slug, profileId).kb));
}
```

- `deliveringContextGrants(frontmatter, reviewerProfileId, resolve)` (:270-282,
  was `deliveringKbGrants`) — returns the delivering engagement's grants via
  `deliveringEngagement(fm)`, or `[]` when there is no deliverer / the deliverer
  IS this profile / the deliverer is undeployed (resolve throws → caught).
- `withDeliveringGrants(own, resolveExtras)` (:289-299, was `withDeliveringKb`) —
  reviewer's own list first, the deliverer's extras appended, **deduped** so a
  shared resource is injected (and charges the shared budget) once.

**Accuracy note (verified pass 19)**: the helpers were renamed to generic
"context grants" and their docstring says "widened to SKILLS by LV-F3"
(:262), but **both call sites still union `kb` only** (:788-795 fresh,
:1676-1683 resume). A reviewer does NOT inherit the deliverer's *skills* today.
Treat the rename as prospective. (`b0f3f99` exists purely because the rename
landed without its call sites — tsc was red on the branch for one commit.)

The delivering run and the operator run (separate `buildOperatorSystemPrompt`
path) are untouched.

### 3.2 R18-3 — strip the ungoverned repo `.claude` catalog

Fix `e274134`; **MOVED** to `app/server/runtimes/skill-mount.server.ts:61-88` by
`776e0ed` (a stub comment marks the old home at `specialist-run.server.ts:1822-1826`).
`stripUngovernedRepoCatalog(repoDir)` is called from THREE places now: both
`cloneRepo` return points (reuse :1868, fresh clone :1887) and — always, fresh or
resumed — from `mountGrantedSkills` itself (`skill-mount.server.ts:166`), so the
"only Viberr content is discoverable" guarantee no longer depends on caller
ordering. Because `.claude` is git-TRACKED and delivery auto-commits with `git
add -A`, a plain `rm -rf` would ship a `.claude` DELETION into the review PR — so
the helper first marks every tracked `.claude` path `git update-index
--skip-worktree` (`skill-mount.server.ts:65-77`), then `rmSync`s the dir (:87).
Git then treats the absent files as unchanged; the committed tree keeps `.claude`
from the index. A skip-worktree failure is non-fatal (logged; the catalog is
still stripped). Documented limitation: a task to edit the repo's own `.claude`
can't deliver those edits — the intended governance posture. Claude's user-level
catalog is separately governed by `CLAUDE_CONFIG_DIR` isolation in production
(`claude-config.server.ts`); `strictMcpConfig` closes the MCP channel (§2).

### 3.3 R18-5 — granted skills reach a Claude run through the SDK (NEW, `776e0ed`)

Owner ruling: use the documented SDK `skills: ["name", …]` option instead of
pasting every granted skill body into the system prompt on every run.
`app/server/runtimes/skill-mount.server.ts` (333 lines) owns the workspace
`.claude` end to end.

`mountGrantedSkills({workspaceDir, skills, dataRoot})` (:145-188) →
`{mounted: string[], skipped: {name, reason}[]}`:

1. Dedupe; return early with everything `skipped` when there is no workspace or
   it is not a **plain git checkout** (`isPlainGitCheckout`, :192-198 — `.git`
   must be a real DIRECTORY, so a worktree/submodule pointer refuses). Reason:
   `settingSources:['project']` walks from cwd up to the repo root, so mounting
   anywhere that is not a repo root could walk into a host `.claude` (the F13
   leak — `docker-data/` lives inside the viberr checkout on a dev machine).
2. `stripUngovernedRepoCatalog(dir)` FIRST (:166) — every run, including resumes,
   so a previous run's `settings.json` (hooks!) never survives.
3. `excludeCatalogFromDelivery(dir)` (:210-236) — appends `.claude/` to
   `.git/info/exclude` (repo-local, never committed, binds both `git add -A`
   delivery and the agent's own commits). Idempotent.
4. Per skill, `mountOneSkill` (:239-301): refuse a name outside
   `SDK_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (:104, exported as
   `isSdkSkillName` :106); resolve through `resolveContainedSkillFile` (the same
   containment question the injector asks — no symlinked folder/SKILL.md, nothing
   outside the store); `cpSync` the WHOLE folder with `dereference:false` and a
   `copyableEntry` filter that refuses symlinks and nested `.git` (:305-312); then
   **rewrite `SKILL.md`'s frontmatter** to exactly `{name, description}` (:284-291).
   Normalization is load-bearing twice over: store SKILL.md files carry no
   frontmatter (native discovery would silently drop them), and skill frontmatter
   could otherwise carry `allowed-tools`/`model`/`disable-model-invocation` —
   run policy Viberr owns through capability grants.
5. If NOTHING mounted, the whole `.claude` is removed again (:177-180) so the
   workspace is byte-identical to a skill-less run.

`skipped` entries are **diagnostic, not capability loss**: they fall back to
prompt-text injection via `buildSpecialistPersona` (§3). The hybrid is by design —
Codex, a run with no checkout, an SDK-unsafe folder name, or a symlinked store
entry all keep the text carrier.

**Not yet covered**: skills mounted from a store folder are re-copied on every
run (no caching), and `description` falls back to the first non-heading line of
the body when the store file declares none (`skillDescription`, :315-333).

---

## 4. The agent toolkits (in-process MCP servers)

- **`viberr_agent`** (`agent-toolkit.server.ts`: `buildAgentToolkit` :214,
  `createSdkMcpServer` :373) — the specialist's
  capability-gated toolkit: `post_comment` (gated on `comment-on-task`),
  `ask_human` (opens a question packet, gated on `ask-human`, stamps `askedBy`),
  `report_outcome` (stages the verdict/completion envelope, gated on
  `report-validation-verdict` + `attach-evidence-references`). The final report
  always posts via the completion pipeline regardless of `comment-on-task`.
- **Operator toolkit** (`operator-toolkit.server.ts`) — `post_comment`,
  `prompt_agent` (engage/run a specialist, `delivers` flag), `deliver_for_review`,
  `transition_stage`, `accept_completion`, `resolve_decision_packet`, etc. Each
  tool gates on the operator's capability grant + autonomy (`gate` :274,
  `deliverGate` :304, `operator-actions.server.ts`; `type Gate = "direct" |
  "recommend" | "deny"` at :125).

---

## 5. Delivery pipeline (server-owned push + PR)

Agents never push; the SERVER performs delivery. `operatorDeliverForReview`
(`operator-actions.server.ts:1813`) gates on `deliver-review-pr` via
`deliverGate` (:1819) — under supervised autonomy it returns `recommend` and
posts a recommendation card instead of pushing (:1835-1849); under full/direct it
calls `performDelivery` with `operatorAuthorized: true` (:1860-1862). Human
paths: `manualDeliverForReview` (`task-actions.server.ts:3675`, the button) and
`applyRecommendation`'s delivery branch (`applyRecommendation` :5411).

`performDelivery` (`task-actions.server.ts:3359`) → `pushWorkspaceBranch`
(`github/push-workspace.server.ts`, the `git add -A` commit) → `openTaskPr`
(`github/pr-open.server.ts`, opens the review PR, writes the "Opened PR" github
timeline event, mints the `workRevision`). It no-ops on a live PR (idempotent).
On success it clears a stale `noChanges` flag (R17-2, :3543-3545); the
`nothing_to_review` result SETS it at :3482 / :3621.

### 5.1 R18-2 — full-autonomy re-queue after delivery

Fix `e07abc0`. Opening a review PR is delivery, NOT a stage transition, so the
per-transition operator re-trigger and the stranded-operator backstop never fired
— an autonomous task sat `waiting:human` with empty `recommendations`, no packet,
no card (F18-10, live-caught on LAB-1). Now, inside `performDelivery`'s
`result.status === "ok"` branch (`task-actions.server.ts:3556-3574`):

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
- `autoInvokeOperator` (:687, trigger union widened to include `"delivered"`)
  no-ops when no operator is deployed and threads `nextTransitionChainDepth(ctx)`
  (:128) so the operator-authored chain shares `OPERATOR_TRANSITION_CHAIN_CAP`
  (=8) — no runaway.
- The re-queued run is idempotent: `operatorDeliverForReview` no-ops on the live
  PR, and the queued trigger is mutually exclusive with the stranded-resume
  backstop (`releaseOperatorLease` fires the queue then returns).

---

## 6. Operator triggers (`operator-run.server.ts`)

`RunOperatorInput.trigger` union — **8 values** (:97-105): `create`,
`transition`, `agent-reply`, `goal-updated`, `pr-diverged`, `delivered`,
`scheduled`, `manual`. `OperatorTrigger = NonNullable<...>` (:2100).
Single-flight lease per task; concurrent triggers are queued newest-wins
(`queueOperatorTrigger` :285) and fire on lease release (:712, :747).
`operatorTurnInstruction` (:2153) computes the one-next-step instruction; the
`delivered` branch (:2230-2243) tells the operator delivery is DONE — engage a
verdict-capable reviewer / accept / transition, and stop if a reviewer run is
already in flight. The **triage quality gate** `triageQualityGate(snapshot)`
(:2136) blocks Triage→Ready until a vague goal survives scoping (F15-14;
placeholder `DEFAULT_GOAL`, `task-actions.server.ts:421`).

---

## 7. Guardrails (`comment-guardrails.server.ts`)

Real write-time enforcement on the CANONICAL record (owner ruling Q3):
`isMeaninglessComment` (:28), `enforceOperatorBrevity`
(`OPERATOR_BREVITY_MAX_CHARS = 1000`, :36-51), `separateEvidence` (trims raw
fenced dumps to `EVIDENCE_MAX_FENCE_LINES = 12`, pointing at run logs, :63-77).
`applyCommentGuardrails` (:113) runs them and REPORTS what it did (`CommentTrim`);
its live consumer is the operator's `post_comment`
(`operator-actions.server.ts:395`, the G1 honesty wiring — a dropped comment
becomes a noop + audit row, never a silent success).
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

`run-recovery.server.ts` (`finalizeOrphanedRuns` :51, `recoverUnreactedAgentRuns`
:194, `recoverStrandedOperatorPlans` :350) reconciles runs interrupted by a restart;
`run-projection.server.ts` projects `agent_runs` + `run_log_lines`;
`session-export.server.ts` builds the downloadable transcript installer
(`/resources/session-export`). Run cost/turns/duration surface on the task
timeline.

---

## 10. Delta summary (pass 18 + pass 19)

| Change | Commit | Files |
| --- | --- | --- |
| R18-1 reviewer inherits deliverer KBs | `97131bd` | specialist-run.server.ts:270-299, 787-796, 1674-1684 |
| R18-3 strip repo `.claude` + strict MCP | `e274134` | **moved** → skill-mount.server.ts:61-88; specialist-run.server.ts:1868, 1887; claude-runtime.server.ts:615 |
| R18-2 full-autonomy delivery re-queue | `e07abc0` | task-actions.server.ts:3556-3574, 687; operator-run.server.ts:103, 2230-2243 |
| R18-4 (KEEP) branch-collision stays a human-gated packet | — | no code change (intentional) |
| **R18-5 native SDK skill mounting** | `776e0ed` | **NEW** skill-mount.server.ts (333 lines); claude-runtime.server.ts:242-312, 555, 607-615, 663-665; specialist-run.server.ts:867-890, 1188-1260, 1690-1712; adapter.server.ts:50-58; run-service.server.ts:229-231, 683-689 |
| R18-1 helper rename repair (tsc was red) | `b0f3f99` | specialist-run.server.ts:262-299, 788, 1676 |

R18-4 rejected the "always force-reset the remote task branch at execution start"
option — the collision packet + human resolve is an intentional safety checkpoint,
so there is deliberately no code change.

### Pass-19 verification notes

- `resolveResumeConfinement` is now **async** — its one production caller
  (`task-actions.server.ts:1217`, dynamic import) must `await` it.
- The reviewer-inheritance union is KB-only despite the renamed helpers (§3.1).
- `settingSources: ['project']` is opened ONLY for a run that mounted ≥1 skill;
  a skill-less run is byte-identical to pass 18.
- Live evidence recorded on the branch (`d69af18`, `b312464`, `22eb352`): a Codex
  run given a relevant + a decoy skill used only the relevant one (prompt-text
  carrier; relevance filtering is the model's job, there is no progressive
  disclosure on Codex); Claude MCP servers mount but their tools arrive
  **deferred** (a pending tool list is not a failure); credentialed MCPs
  authenticate on Claude only (Codex argv would leak the secret).
