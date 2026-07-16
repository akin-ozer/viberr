# Owner rulings — pass 7 (2026-07-16)

Explicit AskUserQuestion answers from the owner in this session. Numbered R7-x.

- **R7-1 · Role-bindings rework = CLEANUP + IMPLEMENT D2.** Consolidate the 12 seams
  (rbac-inventory.md §9) into a single guard path — action-ids everywhere, one owner-exception
  helper, one archived gate, one rank scale, honest Policy rows — with no tier changes beyond:
  **implement pass-5 owner ruling D2 on main**: org admins get visible, AUDITED emergency
  project-admin authority on any project without membership (`org_admin_override`-style audit
  trail), fixing the read/act asymmetry.

- **R7-2 · Simulation: DON'T SIMULATE AT ALL (product + demo seed).** Supersedes the pass-1-era
  simulated-fallback design and settles pass-5 D12 decisively:
  - PRODUCT: an unavailable backend must NEVER produce a fake run. Keyless/broken-credential
    runs surface an honest "backend unavailable" error + typed blocked packet. The silent
    simulated fallback in runtime selection is removed.
    (By extension: no simulated verdicts, no simulated governance evidence — F7-SIM1 moot.)
  - DEMO SEED: `npm run seed` ships NO fabricated run history (no simulated agent_runs rows,
    no scripted run logs). Tasks/projects/members remain.
  - E2E: a deterministic test-only adapter may remain for Playwright, gated so it is
    unreachable in production (env flag; fail-closed outside test).

- **R7-3 · (carried from Q&A phrasing) Cleanup includes honest split of member management:**
  invite/remove/role-change should sit on `manage-members` semantics rather than riding
  `edit-policy` — part of the R7-1 consolidation, no tier change (both stay admin today).

- **R7-4 · Failed-review rework: OPERATOR MAY TRANSITION BACKWARD.** On a failing reviewer
  verdict, an operator with stage-transitions authority may move Review→In Progress itself
  (one governed, audited backward edge) and re-drive the specialist. The escalation packet
  remains the fallback when the operator lacks authority. (Closes F7-FLOW1.)

- **R7-5 · Specialist capability picker: COLLAPSE TO 3 HONEST MODES.** Specialist-scoped
  capabilities offer Allowed / Human-only / Off; `recommend` remains operator-only where it
  has real semantics. Existing specialist `recommend` grants coerce to Allowed on read.
  (Closes F7-CAP1.)

- **R7-6 · Done tasks stay commentable.** No freeze on Done; optional subtle "task is
  closed" hint in the composer. (Closes F7-UI4 as WONTFIX-with-hint.)
