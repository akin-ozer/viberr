# Prompt for a fresh session: implement the Option D plan

Paste everything below the line into a new Claude Code session opened at `/Users/akinozer/projects/viberr`.

---

You are implementing an already-decided plan in the Viberr repository. Do not re-evaluate the decision, do not run
research workflows, and do not ask the questions that are already answered in the plan. Read, then build.

## Read first, in this order

1. `AGENTS.md`, then `docs/README.md`, then `docs/architecture/decisions.md` (the numbered rulings; code cites them as
   "ruling N") and `docs/development/contributing.md` (§4 schema changes, §5 docs pinned by tests, §7 definition of done).
2. `planning/option-d-2026-09-11/PLAN.md`. This is the work. It has seven items (P0 and PR 1 to PR 6), each with the
   exact files and line anchors, TypeScript sketches, tests with the seam to use, docs to update, draft ruling text,
   exit criteria and a canary.
3. Only for background if a "why" is unclear: `cognipeer-docs/27-viberr-adoption-assessment.md` sections 1, 8.1 (Option D)
   and 8.3. Everything else in `cognipeer-docs/` is reference about a library we are NOT adopting.

## Decisions already taken by the owner (2026-09-11), do not re-ask

- D1: Codex Stop escalation uses a wrapper script shipped in the image and pointed at by `codexPathOverride`.
- D2/D3: P13-KM-04 is closed now; the stdio probe proposes write-looking tool names, the admin confirms them in the MCP
  server editor, and the confirmed names are denied on runs whose repo-write grant is withheld.
- D4: the per-run cost cap is an instance-level ceiling only (org settings, default none). No profile field, no
  file-format change.
- D5: the wall-clock cap (PR 4c) is deferred. Skip it.

## Order and branching

Implement in this order, one branch and one PR per item, each cut from current `main`:
P0 (ruling only) → PR 1 → PR 3 → PR 4 (parts a and b only) → PR 2 → PR 5 (spike first; drop the PR if the spike fails
and record the failure as a dated note under ruling 101 instead) → PR 6.

Rulings: the plan reserves 173 (P0), 174 (PR 1), 175 (PR 2, amends 39) and 176 (PR 3). Confirm the next free number with
`grep -oE "^[0-9]{3}\. \*\*" docs/architecture/decisions.md | sort -n | tail -1` before writing each one; if the numbers
have moved, renumber consistently and update the plan's references in the same PR.

Branch names: `option-d/p0-decision-record`, `option-d/pr1-permissions-and-kill`, `option-d/pr3-cost-cap-usage`,
`option-d/pr4-alwaysload-once-only`, `option-d/pr2-mcp-tool-gating`, `option-d/pr5-pretooluse-deny`,
`option-d/pr6-hygiene`. Commit messages follow the repo's existing style (imperative, name the ruling). Follow the
repository's own attribution rule: no `Co-Authored-By: Claude` trailer and no "Generated with Claude Code" line in commits
or PR bodies.

## Definition of done for every PR (contributing §7, non-negotiable)

1. `npm run lint && npm run typecheck && npm test && npm run build` green locally. `npm run e2e` (needs Docker) for PR 1
   (image change), PR 2 and PR 3 (org-settings UI). CI may be billing-blocked; local gates are the gate.
2. New behaviour is tested through the existing seams the plan names (`claudeQueryFn`, `codexFactory`,
   `configureRunServiceForTests` / `test-support/fake-runtime.ts`, the route harness, the real file writers).
   Never `vi.mock`. `npm run lint` has no suppression list: fix findings, never allowlist.
3. Every raw `VIBERR_*` env read is declared in `app/server/config/env.server.ts` and `.env.example`
   (`env.server.test.ts` gates it). Tests that set env call `resetEnvCacheForTests()`.
4. Audit rows and typed timeline events for any new governed action (PR 2's policy save, PR 4's duplicate outcome).
5. Docs updated in the same PR with a dated update line (`docs/domain/agents-and-runtime.md` header,
   `docs/README.md`); the ruling text written into `docs/architecture/decisions.md`.
6. Secrets never reach files, logs, SSE payloads or agent environments.

## Traps recorded from earlier sessions

- One app process per data root, ever. Never run a host dev server and the compose container on the same
  `docker-data`. `npm run seed`, `rescan`, `restore` refuse against a running app on purpose.
- `getEnv()` caches per process; tests that change env must reset it.
- In RTL tests, `await findBy*` does not guarantee mount effects ran.
- Before pushing, check `git log` on your branch: concurrent sessions have committed onto branches before.
- Live canaries (the plan names one per PR) spend the owner's Claude or Codex account. Prepare the exact steps and
  ask the owner to run them or to approve you running them; do not start live runs unprompted.

## What to report at the end of each PR

Branch, PR link, the ruling number used, gate results (paste the summary lines), what the canary needs, and anything
you deliberately left out with the reason. If a plan anchor no longer matches the code (line numbers drift), say what you
found instead; do not silently change the design.

Start with P0. When it is merged or the owner says to continue, move to PR 1.
