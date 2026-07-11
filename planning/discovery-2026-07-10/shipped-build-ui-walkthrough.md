# Shipped-build UI walkthrough (2026-07-11)

A systematic page-by-page visual + content QA of the COMMITTED build (`ac84539`, seeded canonical
state, both backends real). Every workspace page, org-settings tab, and overlay inspected for visual
coherence and correct reflection of the D1–D4 changes. **Result: clean bill of health — no
regressions, no new mocks/unwired surfaces, no new product questions.**

| Page | Verdict | What was checked |
|---|---|---|
| **Home** `/` | ✅ | Greeting, pinned/everything-else grids, settings strip. "**3 global agents**" (post-D1), 3 projects. |
| **Board** `…/board` | ✅ | 5 stages (Triage/Ready/In Progress/Review/Done), cards with key/agent/branch/PR, Re-scan + New task. **No "Tester"/"Advisor" anywhere** (D1). |
| **Agents** `…/agents` | ✅ | 3 profiles: Operator + Developer + **Reviewer "Review & validation"** (D1). Operator "never closes a task itself" copy intact. Capability policy 3-column. |
| **Review queue** `…/review` | ✅ | "Waiting on your acceptance" vs "Still with agents" split; VIB-142 completion + VIB-145 in review. |
| **Policy** `…/policy` | ✅ | Human RBAC (4 members) + Agent capability (3 profiles). Workflow rules show "**Triage → Ready · Auto-advance · Operator, once the goal is scoped**" (D2). review→done locked human. |
| **GitHub** `…/github` | ✅ | Repo config, credential card (honest missing-scope flag), 4 linked PRs, branch traceability table. |
| **Activity** `…/activity` | ✅ | Stream (day-grouped) + audit log. **No stale Tester/Advisor** references; Codex + Claude both present. |
| **Settings** `…/settings` | ✅ | Project identity, 5-stage editor w/ counts, 4 members, repo & credentials, danger zone (archive/delete). |
| **Task detail** `…/tasks/VIB-142` | ✅ | Operator-first layout: decision packet dominates, execution profile = Operator + **Developer + Reviewer** (no Tester), human owner, permissions panel. |
| **Org → Users** `?tab=users` | ✅ | 5 users w/ roles; **disable/enable UI present** (#12). |
| **Org → Resources** `?tab=resources` | ✅ | Global profiles = **Developer + Reviewer only**; disk-truth skills incl. developer/reviewer/viberr-app-expertise (#7); no domain-advisor / tester-expertise. |
| **Notifications** overlay | ✅ | "Waiting on you" + "Everything else"; BIL-9 reads "**To do → In progress**" (lightweight-stage fix); All/Unread + mark-all-read. |
| **Profile** overlay | ✅ | Notification routing = **5 category toggles** (wired, #4); **no nudge/email-channel** UI (#20); theme Light/Dark/System; GitHub identity. |

## Critical findings from this pass — owner-decided + IMPLEMENTED

The pages RENDER coherently, but a critical read of the create/govern flow surfaced three genuine
product gaps that were NOT deliberate design. Asked the owner; all three decided and implemented:

- **S1 → WIRED (owner: make presets differ).** The create-project policy preset now shapes REAL
  governance (`project-create.server.ts` `presetWorkflow`/`presetAgents`): **strict** turns the
  pre-work `auto` boundaries into `approval` (a human gates triage→ready and ready→impl before any
  agent touches the repo); **balanced** = template defaults; **auto** runs the operator at full
  autonomy. review→done stays human-locked in every preset. 3 governance tests.
- **S2 → BUILT (owner: add a Complete-merge action).** `completeTaskMerge` + a "Complete merge"
  button on the task's GitHub panel when `pr.state==="accepted"`; runs the real `mergeTaskPr` once a
  PAT is configured, flips to "merged", and reports an honest failure (never a fake merge) when it
  still can't. admin|maintainer. 4 tests. Pill now reads "PR #N · merge pending".
- **S3 → DOCUMENTED (owner: note for the role-bindings phase).** Codex specialist runs have no real
  tool confinement — the Claude adapter enforces `disallowedTools`, but the Codex SDK ignores
  allowed/disallowed tools and runs `danger-full-access` with the machine env. So an agent's
  capability policy is truly ENFORCED only for Claude-backed agents; for Codex it is prompt-only.
  Recorded here + in the completeness ledger (#33) as a known gap to close during the role-bindings
  work the owner flagged (security deprioritized for now).

_(Original finding text, for the record:)_

- **S1 — the create-project policy preset is COSMETIC (unwired mock).** "Strict human-gate /
  Balanced / Autonomous" only changes the project *description string*
  (`project-create.server.ts:132-136`); `agents: defaultAgentDeployments()` (line 150) deploys the
  IDENTICAL capability policy for all three. The code even says so: "agent capability presets arrive
  with Phase 8/9" (line 54). So a user picking "Strict human-gate" gets the same governance as
  "Autonomous." This is the natural entry point for the owner's stated "touch role bindings" work.
- **S2 — no way to complete the real merge of an "accepted" PR.** After D3, a Done task whose PR
  couldn't be server-merged shows `pr.state="accepted"` ("merge pending") and its real PR stays OPEN
  on GitHub. There is no viberr affordance to actually run that merge later once a PAT is configured;
  the GitHub-page `reconcile` only FETCHES state (and would map the still-open PR back to "review").
  A "Complete merge" action is missing.
- **S3 — auto-advance (D2) starts real repo work with zero human gate.** A well-scoped task flows
  creation → operator → Codex Developer opening a REAL branch+PR on GitHub with no human click. That
  is the intended power, but there is no per-project option to require a human "start work" gate
  before the first repo mutation — which is exactly what the (currently cosmetic) "strict" preset
  should provide. Ties into S1.

Plus the standing documented limitation: **Codex capability caps are prompt-only** (the Claude adapter
enforces `disallowedTools`; the Codex SDK ignores them) — relevant to role-bindings work (#33).

## Notes
- Boot restores the built-in agents' expertise skills (`developer/reviewer/viberr-app-expertise`) —
  confirmed present on disk after a server boot. (The transient absence after a raw `npm run seed
  --reset` without a reboot is a dev-CLI nuance, not a product bug; see the completeness ledger.)
- Everything tied to the DECIDED changes (D1–D4 + A–E) is internally consistent across the UI.

## Cross-reference
Behavioral verification (operator, agents, RBAC, MCP, skills, backends) is in
`test-sweep-committed-2026-07-11.md`; the full findings-to-implementation map is in
`completeness-ledger.md`.
