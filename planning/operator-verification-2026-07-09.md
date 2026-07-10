# Viberr operator + product verification — 2026-07-09

Total verification pass on the operator agent and everything it touches, run against the
`cc-devops-skills` project on the live dev site plus a full-codebase audit. Method: a 9-agent
subsystem code-map, 20 live/coded use cases in cc-devops-skills (real Claude runs + curl RBAC
matrix across 5 seeded users), and an independent Opus fresh-eyes PRD-vs-reality sweep. Two
independent passes (my live testing and the fresh-eyes audit) converged on the same conclusions.

## Headline verdict

The operator's **reading, representation, and authority-gating spine is genuinely well-built**,
and on live data it shows real judgment. But the three **generation** behaviors the PRD's vision
rests on are absent or orphaned at runtime:

1. **It never generates decision/blocking packets** (FR26, Journey 2) — the artifact the whole
   product is built around.
2. **The GitHub delivery loop is dead code** — no branch, no commit, no PR is ever created for
   real work; completion just fakes `pr.state="merged"`.
3. **The anti-noise guardrails and typed-event system are inert seed prose** — real runs degrade
   to a flat, unbounded comment log.

Viberr demos beautifully on seed data and thins out on real runs. The operator is solid as a
coordinator but not yet trustworthy as "what makes Viberr intelligent," because its defining
outputs — packets, traceable delivery, recoverable failure — don't exist at runtime. This is
focused wiring-and-generation work, not a rebuild.

---

## What genuinely works (verified live)

- **Operator core loop is real.** Real Claude runs (not simulated), correct SOP: `get_task` →
  observed/plan comment → capability-gated action, via a real in-process `viberr` MCP server (10
  `mcp__viberr__*` tools observed being called). `allowedTools` confinement, audit rows, the
  react loop, and the no-progress guard all fire.
- **The operator shows real intelligence.** On CCD-1 it refused a Codex developer's unverified
  "done" report, summoned the Claude reviewer to independently inspect the workspace, correctly
  called "nothing implemented → request changes," and re-prompted the developer with the
  reviewer's concrete findings. This is the product at its best.
- **Steering works** — an `@operator` comment made it restate its plan under a new constraint and
  explicitly hold ("no transition or specialist prompt until you confirm").
- **Full autonomy** drove a coordination-only task (CCD-3) triage→done alone with an honest
  "audited override" completion event.
- **Human RBAC matrix is correct** where the matrix defines a gate: create-task (viewer denied),
  approval transitions (contributor/viewer denied, maintainer allowed), assign/run specialist
  (admin/maintainer only), org settings (member denied). Verified by curl across 5 users.
- **ALWAYS_HUMAN + "human" mode enforcement is real** — merge-PR / transition-to-done /
  change-policy are coerced to human at persist and denied at the Claude tool layer.
- **Skill injection is real end-to-end** — a skill created in the UI, attached to a profile,
  reaches the agent's system prompt (instrumented and proven: `hasMarker=true`).
- **Operator's `viberr` MCP is the one real MCP integration.**
- **File-native store + chokidar watcher** reproject hand-edited task/project files instantly
  (FR10). Board/task-detail live-update over SSE.
- **The DecisionPacket UI, recommendation cards, runtime-session export (FR23)** are all
  well-built — they just lack a runtime generator feeding them.

---

## Bugs & wrong logic (prioritized)

### Blocking the vision

- **B1 — Operator generates no decision/blocking packets.** `generate-packets` is a declared
  capability wired to no `gate()` and no tool; every runtime `.packet =` is a null-clear. The
  only packets that exist are demo seed. At its authority limit the operator posts a
  recommendation card or strands the task at `waiting:human, packet:null` with a 500-word reviewer
  wall as the "latest event" — the exact "vague chatter" Journey 2 says a packet replaces.
  *Live proof: CCD-1 was failed by the reviewer five times, then simply stalled with no packet.*
  Files: `operator-toolkit.server.ts`, `operator-actions.server.ts`, `capability-catalog.ts:100`.

- **B2 — Task→branch→commit→PR delivery is orphaned/faked.** `ensureTaskBranch` (branch creation)
  and `mergeTaskPr` (merge) are fully implemented against the real GitHub API but have **zero
  non-test callers**. No PR-creation code exists anywhere. `startSpecialistRun` uses an
  "analyze and report" prompt, so no code is ever written or committed. All three accept paths
  just flip the cached string `fm.pr.state="merged"` with no GitHub call. cc-devops-skills tasks
  all have `branch/repo/pr/github: null`, including CCD-1 at Review.
  Files: `github/branch-sync.server.ts:177`, `github-reconciler.server.ts:387`,
  `specialist-run.server.ts:855`, `task-actions.server.ts:1637/1782`, `operator-actions.server.ts:883`.

- **B3 — The supervisor is never pinged for a decision.** `createNotification` has only two
  non-seed callers (@mention fan-out, GitHub scope flag). New operator recommendations, waiting=human
  transitions, and packets create no notification. The bell and the whole "Waiting on you" inbox
  are fed only by demo seed, so in real use they stay empty while tasks silently wait.
  *(Journey 2 + "blocked tasks reach a human decision quickly.")* File: `task-actions.server.ts`.

### Major

- **B4 — Specialist capability mode "off" is a silent no-op.** `grantsFor` drops `off` grants at
  persist (`if (mode === "off") continue`), but `resolveSpecialistDisallowedTools` only denies a
  tool when it *finds* `mode === "off"`. Setting a specialist's `create-task-branch` /
  `commit-push-branch` / `open-review-pr` to "off" leaves the tool fully available — the exact
  opposite of the admin's intent. Only "human" mode actually withholds.
  Files: `agent-profile-actions.server.ts:154`, `specialist-tool-policy.ts`.

- **B5 — Codex specialist runs have no tool confinement.** `disallowedTools` is a Claude concept;
  Codex runs ignore it and (autonomously) get danger-full-access. Any repo-mutating capability set
  to human/off is unenforced for Codex-backed specialists.

- **B6 — No per-task operator concurrency guard.** Confirmed live: creating CCD-2 and immediately
  `@operator`-commenting it started two overlapping operator runs. The per-file mutex serializes
  writes but not the snapshot→decide→act sequence, so concurrent triggers can double-assign or lose
  writes (NFR16 idempotency risk).

- **B7 — Validation status and "Needs attention" are seed-only.** The board's `validation`
  (healthy/changed/failing) and `urgent` fields are assigned only in demo seed; no live path derives
  them from reviewer verdicts or CI. A task failed five times reads `validation: none` and never
  surfaces under "Needs attention." (FR24 card requirement + Journey 2 trigger.)

- **B8 — Packet "redirect / re-engage specialist" is narrated, not executed.** Resolving a redirect
  writes an event saying "Operator re-engages the specialist" but never calls `autoInvokeOperator`
  or starts a run; the task sits at `waiting:agent` with nothing running.

- **B9 — Restart drops the react loop.** Run-completion callbacks live only in-process
  (`run-service.server.ts`); a mid-run restart loses the agent reply and operator reaction and
  strands the task with no error (NFR17). Seeded `keepRunning` demo runs, meanwhile, tick as
  "running" forever.

- **B10 — Simulated work is not marked in the canonical timeline.** Only the run row carries
  `simulated:true`; the timeline comment "@operator — done: implemented… suite passes" enters as an
  ordinary agent comment. Under full autonomy with a simulated reviewer, the operator would accept
  fabricated completion (nearly did on CCD-1). "Process theater" is a named PRD risk.

- **B11 — `readiness: input_required` never clears.** Set at create; the operator has no tool to
  update readiness, so every card (even ones with agents actively working) shows "input required."
  Confirmed on the live board.

- **B12 — GitHub connection state is self-contradictory.** The page shows "token revoked" and "All
  required scopes granted" together; Reconcile with the dead PAT returns 200 with no violation, no
  branch, no PR — a silent no-op presented as success.

### RBAC (view-side)

- **B13 — No view-side project RBAC.** A non-member org user gets 200 on every project view
  including policy, agents, settings, and GitHub connection health. FR4 justifies app-wide
  board/task reads, but config surfaces should be member-gated.
- **B14 — Viewer can resolve non-completion decision packets** (`resolvePacket` gate is `any-member`;
  only `accept_completion` re-gates). A viewer redirecting agent work is a consequential change the
  matrix reserves for admin/maintainer (FR27). Verified: viewer got 409, not 403.
- **B15 — Any authenticated user (incl. viewer/non-member) can trigger board rescan / full projection
  rebuild.** Contradicts the matrix's "admin|maintainer" row.

### Smells / lower

- Consultant/Advisor is a ghost profile on fresh stores (no definition file, its `domain-advisor`
  skill doesn't exist, KB refs are phantom) yet every new project deploys it.
- Seeded MCP registry rows fabricate health/tool counts against nonexistent hosts, shown as healthy.
- Preinstalled expertise skills are invisible to the org Skills panel (no `org_skills` rows).
- Seeded notifications DEP-31/BIL-9 deep-link to tasks that are never seeded.
- Workspace clone embeds the PAT in the git remote URL — readable by every specialist run.
- Every operator run starts with a `ToolSearch` deferred-schema call (a per-run tax).

---

## Missing product strategies (the "lagging behind its own vision" list)

Ranked; the first two block the vision.

1. **Close the GitHub delivery loop end-to-end.** On entering the working stage, call the
   already-built `ensureTaskBranch`; have specialists implement + commit with the `[KEY]`
   convention + push; on reaching Review **auto-open a PR whose body is composed from the task
   goal + change summary + evidence and embeds the Viberr task URL**; route human accept through
   the real `mergeTaskPr`. *(This is the owner's flagship example — it does not exist today.)*

2. **A runtime decision/blocking-packet generator** wired to a governed operator tool
   (`open_decision_packet` / `open_blocking_packet`), gated by the existing `generate-packets`
   capability, building a typed packet (observations + options + decision-required) and setting
   `waiting=human`. This is the artifact FR26 and the success metrics are built on.

3. **Governance-event → notification fan-out.** Every waiting=human transition, new recommendation,
   opened packet, and quality/blocked flag should mint a notification to the owner/maintainers. The
   table, bell, and "Waiting on you" page already exist and are only wired to @mentions today.

4. **Stuck-loop detection → typed blocked state + recovery packet.** Cross-cycle no-progress
   detection (beyond the per-chain identical-reply guard) that, when a task bounces without forward
   progress, emits a `blocked` event and a recovery packet (reassign / redirect / hold / abandon).

5. **Live validation-health derivation** from reviewer/tester/CI outcomes, feeding the board card
   and the "Needs attention" triage filter (FR24).

6. **An agent-facing typed-event + evidence API** so specialists can emit quality flags, completion
   reports, and blockers with evidence refs (FR15/FR16/FR21/FR35) instead of only plain comments.

7. **Enforce the anti-noise guardrails + add timeline compaction** (meaningful-comment,
   no-duplicate-summary, compression-threshold). Today they are inert `{id,desc,on}` objects on the
   seed project; nothing reads `.guardrails`. Real runs already accrete 35+ raw comments unbounded.

8. **Make the governance knobs real:** wire profile MCP/KB resources to the actual store and enforce
   them (only skills are wired); replace the hardcoded mock `RES_CATALOG` resource picker with live
   org resources so a resource created in settings can actually be granted to an agent; give the
   consultant a real persona; enforce eligible-stages in specialist selection.

9. **Honesty guards:** mark simulated reports in the canonical timeline and refuse
   `accept_completion` / PR-merge on non-real work under full autonomy.

---

## Operator hardening priorities (ordered)

1. Build the packet generator tool (B1 / strategy 2).
2. Add cross-cycle no-progress / loop detection → typed blocked + recovery packet (B8/strategy 4).
3. Per-task single-flight operator lease so concurrent triggers coalesce (B6).
4. Persist a finished-but-unreacted run queue reconciled on boot (B9, NFR17).
5. Refuse to accept/merge simulated work; stamp simulated reports as simulated (B10).
6. Route acceptance through the real `mergeTaskPr` (B2).
7. Emit typed governance events for the operator's own output instead of `type:"comment"` (B-typed).
8. Reconcile `operator.md` / `SKILL.md` with the code — the manual promises a packet the code
   doesn't open.
9. Enforce eligible-stages in specialist selection.

---

## Verification harness (reusable)

- **Subsystem code-map:** 9 parallel readers, one per subsystem, structured `{flowSummary, keyFiles,
  operatorTouchpoints, mockVsReal, suspectedIssues, prdGaps}`. Artifacts under
  `scratchpad/map/*.json`.
- **Live use cases:** driven via the preview browser + `curl` against better-auth email sign-in
  (seeded password `viberr-dev-2828`), CSRF field `_csrf` scraped from the loader stream, cookie jar
  per user. RBAC matrix run across arda(admin)/elif(maintainer)/murat(contributor)/selin(viewer) +
  deniz(non-member).
- **Evidence sources:** `data/projects/<slug>/tasks/<KEY>/task.md`, the SQLite projection
  (`data/state/projection.sqlite`: `agent_runs`, `audit_events`, `notifications`, `project_members`,
  `scope_violations`), run wire logs under `data/runtimes/<backend>/*.jsonl`, and preview logs.
- **Fresh-eyes sweep:** 5 independent PRD-vs-reality lenses + a missing-strategy critic (Opus).
  Artifacts under `scratchpad/sweep/*.json`.
