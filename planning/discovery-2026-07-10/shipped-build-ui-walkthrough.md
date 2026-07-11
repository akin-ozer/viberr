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

## Notes
- Boot restores the built-in agents' expertise skills (`developer/reviewer/viberr-app-expertise`) —
  confirmed present on disk after a server boot. (The transient absence after a raw `npm run seed
  --reset` without a reboot is a dev-CLI nuance, not a product bug; see the completeness ledger.)
- No new critical product questions surfaced — every page reflects the decisions the owner already
  made (D1–D4 + A–E). The UI is internally consistent with the shipped behavior.

## Cross-reference
Behavioral verification (operator, agents, RBAC, MCP, skills, backends) is in
`test-sweep-committed-2026-07-11.md`; the full findings-to-implementation map is in
`completeness-ledger.md`.
