# Pass 14 — implementation plan

Branch: `pass14/product-fixes` off `main` @ `fa138e1`.
Rules for this pass: **no migrations, no backwards compatibility** — breaking changes are
allowed and preferred over compatibility shims. Tests may be reshaped. Nothing deferred.
Every workstream ends with: `npx tsc --noEmit` (build ≠ typecheck), `npm run test`, and a
live check in the running app (screenshot or state read).

## Owner rulings driving scope

- **R14-1** stage eligibility auto-maps by **stage role**, not raw id.
- **R14-2** a task's **owner may resolve any packet** on their own task.
- **R14-3** build a real **task archive**.
- **R14-4** full **KB editor cluster** (view/edit/overwrite-confirm/folder targeting).

## Workstreams (file ownership is exclusive per stream; the lead owns shared contracts)

### W0 — lead: shared contracts (must land before W1–W4 touch them)

| item | change |
| --- | --- |
| LV-01 | invert capability polarity: absent grant ⇒ **withheld** for delivery+verdict caps (`app/shared/capabilities.ts`, `app/server/tasks/specialist-tool-policy.ts`); `resolveUndeployedDisallowedTools` becomes a thin wrapper; repair `capabilities: []` profiles on read |
| R14-1 | stage-role mapping helper in `app/shared/` + deploy-time translation |
| R14-3 | `archived` on the task schema + shared guards/labels |
| RT-03 | drop `execute-code-or-write-repo` from `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`; matrix copy follows |

### W1 — KB / MCP / skills (owner focus)

`app/server/org/resources.server.ts`, `store-files.server.ts`, `kb-injection.server.ts`,
`skill-body.server.ts`, `specialist-mcp.server.ts`, `app/features/org-settings/*`.

KM-01 (MCP rename rewrites references) · KM-03 (skill body budget) · KM-04 (quote-aware
probe) · KM-05 (silent KB drop → visible marker/warn) · KM-08+UI-59/60/61 (**R14-4** KB
editor cluster) · KM-09 (MCP used-by counts) · KM-10 (org modal shows legacy grants) ·
KM-11 (dangling refs render as missing) · KM-12 (comment truth) · KM-13 (KB doc count =
injectable docs) · KM-14 (drop the decorative `viberr` MCP grant) · KM-15 (skip
`viberr_agent` defensively) · LV-09 (a granted-but-unresolvable MCP raises a real
diagnostic, not silence).

### W2 — runtime & agents

`app/server/tasks/specialist-run.server.ts`, `app/server/runtimes/*`,
`app/server/tasks/agent-reply.server.ts`.

RT-01 (fresh undeployed run confinement) · RT-02+LV-04 (**directive on every fresh
mention run**) · RT-04/KM-02 (Codex operator mounts its MCP servers) · RT-05 (auth mirror
refresh) · RT-06/KM-06 (web egress enforced on Codex specialists) · RT-07 (Codex MCP call
log fidelity) · RT-08 (restart window) · RT-09 (boot ordering) · RT-10 (is_error
classification) · RT-11 (interrupt projection) · RT-12 (handle derivation).

### W3 — governance & delivery

`app/server/tasks/task-actions.server.ts`, `app/server/github/*`,
`app/server/projections/decisions.server.ts`, `app/features/review/*`.

**LV-02 (HIGH)** acceptance must respect the workflow graph + stop synthesizing
`validation: healthy` · **LV-07** real merge-failure causes (conflict vs unreachable) +
refuse acceptance on a conflicting PR · LV-05 (queue subline from live state) · LV-06
(acceptance affordance wherever the queue promises one) · **R14-2** owner packet
authority (GV-01/04/07 + prd.md note) · **R14-3** task archive (GV-02) · GV-05 (identity
check before merge) · GV-06 (mention fan-out in operator directives) · GV-09 (notify on
accepted-then-closed) · GV-10 (deliverer swap mid-run) · GV-03 (stale prose).

### W4 — routes & UI honesty

`app/features/**` (non-org-settings), `app/routes/*`.

UI-62 (`note` in the Activity vocabulary) · UI-63 (library stage counts intersect the
board) · UI-R residual batch (upload no-op, silent backend narrowing, `github.com`
literal, UI-52 editor warning, a11y UI-13/15/58) · WL-02 (agent-log wire noise) · WL-03
(needs-attention includes divergence) · WL-04 (scope-labelled waiting counts) · WL-05/06
(role label + pluralization) · WL-07 (no Run buttons on a closed task) · **LV-08**
(no inert destructive controls for insufficient roles).

## Sequencing

1. Lead lands W0 on the branch; typecheck+tests green.
2. W1–W4 in parallel (strict file ownership, subagents forbidden from running git).
3. Lead integrates, resolves cross-stream handbacks, commits each stream.
4. Full verification sweep: typecheck, tests, live re-run of the failing use cases
   (LV-01/02/04/05/06/07/08/09, KM-01, RT-01/02), fresh screenshots.
5. PR against `akin-ozer/viberr`.
