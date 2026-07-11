# Current-state discovery — post-PR-7 tree (2026-07-11, session 2)

A fresh **critical** discovery sweep of the *current* codebase (after PR #7 landed ~73 fixes),
run as a 6-reader parallel workflow (one per subsystem) + a completeness synthesis. The question
each reader answered: on the tree as it stands **now**, what is still mock / unwired / no-op /
decorative / poorly-implemented that a real user would hit? Benign UI `placeholder=` attributes
were excluded by instruction.

**19 findings: 1 HIGH, 7 MED, 11 LOW.** Status: **all functional findings (the HIGH + all 7 MED)
are fixed** — see sections below. Only LOW honesty/cosmetic nits remain open. Subsystem wiring verdicts:
`notifications = fully-wired`; `guardrails-mcp / github-delivery / operator-packets / kb-skills /
store-projection = mostly-wired`. Net read: **not mock — "demo-coherent"**. The engines
(guardrail enforcement, operator packets/recommendations, audit, PR/branch, OAuth-claim) are real
and wired to real call sites; the remaining risk is (a) one genuine functional bug and (b) a
seed/demo layer that renders fabricated credentials/health as green.

## HIGH — fixed this session

**KB injection dropped every nested / non-`.md` doc** — `readKbBody`
([specialist-run](../../app/server/tasks/specialist-run.server.ts) + [operator-run](../../app/server/runtimes/operator-run.server.ts))
did a **flat** `readdirSync` filtered to top-level `*.md`. But `importGithubSnapshot`
([store-files.server.ts:507](../../app/server/org/store-files.server.ts)) always writes imported docs
under a nested `<folder>/…`, and folder-uploads preserve nesting — so **every doc from the real
"Add from GitHub" flow and every uploaded folder was silently invisible to agents**, while the KB
browser showed them, the reindex toast counted them (recursively), and the delete-confirm copy
claimed "Agents lose them on their next context load." Flat seed KBs injected fine, masking the gap.

**Fix (landed):** extracted one shared reader, [kb-injection.server.ts](../../app/server/files/kb-injection.server.ts),
that (1) walks the KB tree **recursively**, (2) matches all text-doc extensions
(`.md/.markdown/.mdx/.txt/.rst/.text`) — also closing the "non-`.md` ignored" MED finding, (3) keeps
the 24k budget but appends an **honest truncation marker** instead of silently clipping — closing that
LOW finding too. Both runtimes now call it; the private copies are gone. 8 new unit tests
([kb-injection.server.test.ts](../../app/server/files/kb-injection.server.test.ts)) cover nesting,
non-`.md`, dotfile/`.git` skipping, budget+marker, absent folder.

## MED — seed-fabrication cluster — FIXED (owner ruling: "honest empty slate")

The owner chose to **ship an honest empty slate**: the seed layer no longer fabricates credentials or
health. Landed changes:
- **org-seed**: removed the three fake MCP rows (`mcp.internal`, `@mcp/server-postgres`) and the
  placeholder default-connection PAT (`ghp_placeholder_seed_…`). A fresh instance seeds **0 MCP
  servers, 0 GitHub connections, 0 PATs** (verified on a fresh seed + in the browser: Org→Resources
  shows "No MCP servers yet", GitHub connections 0).
- **demo-data**: dropped the fake `masked` token from Viberr Core (kept `requiredScopes` as honest
  policy); removed `github-mcp` from the developer/reviewer profiles (no dead-endpoint injection).
- **pat-store**: removed the `policy_display` source entirely — a `credentialPolicy` with no bound PAT
  now reports `source: "none"` (honest "No credential configured" card), never a green "All required
  scopes granted" for a token that doesn't exist. `requiredScopes` still flow through for the
  pre-flight scope check; an open violation still surfaces.
- Tests updated to the honest contract across 8 files; a new test asserts the unconfigured card.

Findings addressed by this ruling (1, 3, 4, 5 below fully; 2 by removing the dead-endpoint ref):

Original detail (for the record):

1. **Fabricated MCP health** — `MCP_SEEDS` ([org-seed.server.ts:259](../../app/server/org/org-seed.server.ts))
   writes `github-mcp → https://mcp.internal:7801/sse` up=1/tools=14 and a non-existent
   `@mcp/server-postgres` up=1/tools=6. Renders green in Org→MCP until a user clicks Test (which
   honestly flips to down).
2. **The only real specialist-MCP path targets that dead, unauthenticated endpoint**
   ([specialist-mcp.server.ts:47](../../app/server/tasks/specialist-mcp.server.ts)) — seeded profiles
   declare `mcps:['github-mcp']`; a real Claude run gets `mcpServers` pointed at `mcp.internal` with
   no auth header (the `secret://mcp/github` ref is never dereferenced). Never exercised in the demo
   because the simulated runtime ignores `mcpServers`.
3. **Flagship "Viberr Core" shows a healthy credential card for a PAT that doesn't exist**
   ([pat-store.server.ts:422](../../app/server/secrets/pat-store.server.ts), `source:"policy_display"`)
   — renders "All required scopes granted" for `github_pat_••••42af` while the connection pill says
   "no credential" and PR-open/Reconcile no-op.
4. **Seeded org default connection is a deliberate fake token**
   ([org-seed.server.ts:293](../../app/server/org/org-seed.server.ts), `ghp_placeholder_seed_akin_ozer_0000`,
   `is_default=1`) — `getDefaultConnectionToken` returns null unless validated, so any default-connection
   feature (incl. StoreBrowser GitHub import) silently no-ops.
5. **GitHub-handle whitelist rows are permanent decorative identities**
   ([org-users.server.ts:114](../../app/server/org/org-users.server.ts)) — synthetic `github.com/<handle>`
   non-email rows only resolve via the OAuth claim, which registers providers only when
   `GITHUB/GOOGLE_OAUTH_CLIENT_ID` env is set; this instance has neither, so the row is unclaimable.
   (The OAuth-claim *logic* IS built and unit-tested — the stale "documented later wiring" comment at
   [users-panel.tsx:19](../../app/features/org-settings/users-panel.tsx) is itself a LOW finding.)
6. **`run_specialist`/`run_reviewer` "recommend" branch was a dead-end — FIXED.**
   ([operator-actions.server.ts:758](../../app/server/tasks/operator-actions.server.ts)) — under supervised
   autonomy it posted a "*Recommendation: … Awaiting a maintainer to confirm*" comment with **no card and
   no apply button**, unlike the sibling assign/transition/accept paths, so a supervised operator stranded
   the task. Fixed: added `run_specialist` / `run_reviewer` recommendation kinds — both operator paths now
   emit an **actionable card** (via `addRecommendation`), `applyRecommendation` starts the run
   (admin|maintainer, RBAC re-checked in `startSpecialistRun`/`startReviewerRun`), and the UI renders the
   card with a one-click Apply. 2 regression tests; verified live in the browser (card + Apply button).

## LOW — honesty/cosmetic (documented)

Notification watcher swallows load errors → notifies nobody with no log (task-actions:261) ·
unvalidated scopes render "All required scopes granted" before any probe (pat-store:405) · server PAT
PR-open on a diff-less branch 422s but is mislabeled `network_unavailable` (pr-open.server.ts:240) ·
decision-packet body renders markdown/backticks literally (decision-packet.tsx:70) ·
`packetOption.accept` schema field is dead (task-file.schema.ts:172) · KB refresh-cadence selector +
"re-index" button are no-ops (resources.server.ts:334) · stale `users-panel.tsx:19` doc comment ·
`project.archived/unarchived/deleted` + `github.reconcile.project` audited but omitted from the
Activity audit whitelist (activity-feed.server.ts:113).

## Open question for the owner — seed/demo policy

The MED cluster shares ONE root cause: the seed layer ships **fabricated credentials + health**
(fake PATs, a fake default connection token, invented MCP endpoints/tool counts) that render as green
until probed. Options: (a) leave as-is (demo convenience), (b) mark seed credentials/health
**unmistakably placeholder** in the UI (a "seed — not a real credential" state), or (c) omit the fake
rows entirely and ship an empty, honest slate. This is a product call, not a code defect — hence
documented, not unilaterally changed. Everything genuinely *broken* (the KB HIGH) is fixed.
