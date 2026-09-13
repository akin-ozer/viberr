# Pass 37 — what the controller built, unaided

One instance conversation, one turn. I gave it the goal at 06:13:34Z and watched. It made
every structural decision itself; I pre-built nothing but its own model (`opus[1m]`/`high`).

> **This file is the day-one record and is left as written.** On day two the controller
> **re-planned the board itself**, twice: once when I told it the chain was narrower than the
> real dependencies (six new tasks, two new goal chains, every `blockedBy` re-derived from what
> is actually consumed), and again when ruling 191 put the measured shell inventory in front of
> it (10 task contracts and 17 goal links rewritten off Postgres/Docker/Testcontainers/Playwright
> and onto what this host can run, plus a rewritten required-reviewer charter). Both re-plans are
> in `FINDINGS.md` and `VALIDATION.md`. What follows is what it built from nothing, which is the
> thing this file exists to record.

## Project

`Shopify Clone Platform` / slug `shopify-clone-platform` / key `SHOP`, on
`akin-ozer/shopify-clone`, policy `balanced`.

Stages — six, all its own choice (the shipped default is triage/ready/impl/review/done):

| # | id | name | boundary out |
|---|---|---|---|
| 1 | `triage` | Triage | auto |
| 2 | `design` | Design | auto |
| 3 | `build` | Build | auto |
| 4 | `review` | Review | auto |
| 5 | `verify` | Verify | auto |
| 6 | `done` | Done | — |

`verify → done` is `boundary: human`, `locked: true`.

## Knowledge bases (2, written by the controller)

- `shopify-clone-architecture` — stack (TS strict / Node 22 ESM, pnpm + Turborepo, Fastify 5,
  zod, Drizzle + drizzle-kit, Postgres 16 one-db-per-service, Redis 7, Next.js 15, Vitest +
  Testcontainers + Playwright, Compose behind a Makefile); an 8-row service/port/ownership
  table; 5 network-boundary rules; a compensating **checkout saga** with a persisted
  `order_saga_steps` table and a per-service transactional outbox; the JWT/refresh design.
- `shopify-clone-conventions` — branch and PR discipline, **path-set ownership**, and the
  anti-collision protocol below.

### The anti-collision answer (its own, unprompted)

I asked how it would keep several agents out of each other's way in one repo. It named four
collision hot spots and made each one *additive* so two agents never edit the same line:

1. `packages/contracts` — one file per bounded context, re-exported from `index.ts`. A new
   context = a new file + one export line.
2. Gateway routing — `services/gateway/src/routes/<service>.ts` per upstream, auto-registered
   by **directory scan**, so adding an upstream never edits a central route table.
3. Compose — `docker-compose.yml` includes `compose/<service>.yml` fragments.
4. CI — the Actions matrix is derived from `pnpm -r list --json` at runtime, so a new
   workspace needs no workflow edit.

On top of that: one task = one task-key branch = one PR; every task's text names the path set
it owns and the diff may not leave it; the four hot spots are serialized through goal-chain
`blockedBy` so two are never in flight at once.

## Skills (5, written by the controller)

`service-delivery`, `storefront-delivery`, `platform-infrastructure`, `delivery-review`,
`stack-verification`.

## Agent profiles (6 new, all Codex / `gpt-5.6-luna` / effort `max`)

| profile | stages | role |
|---|---|---|
| `platform-architect` | triage, design, build | settles boundaries, schemas, contracts before anyone builds |
| `backend-engineer` | design, build, review | one backend service slice end to end |
| `frontend-engineer` | design, build, review | storefront + admin against the gateway contracts |
| `infrastructure-engineer` | design, build, verify | workspace, compose, migrations, CI, observability |
| `code-reviewer` | build, review | **required reviewer at Review** |
| `integration-verifier` | review, verify | **required reviewer at Verify** |

Required reviewers (ruling 178) set in one call:
`review → code-reviewer`, `verify → integration-verifier`.

## Model policy — honoured in full, operator included

The owner's rule was: controller on Opus high, **everything else** on Codex `gpt-5.6-luna`
at `max`. Verified on disk, not from the reply:

- `agents/profiles/controller.md` → `backends: [claude]`, `model: opus[1m]`, `effort: high`.
- All six new specialist profiles → `backends: [codex]`, `model: gpt-5.6-luna`, `effort: max`.
- The two stock profiles it inherited (`developer`, `reviewer`) still carry `claude`/`sonnet`
  at the **global** level, but their **project deployments** were overridden to
  `codex`/`gpt-5.6-luna`/`max`.
- **The operator too.** Its global template keeps the display placeholder
  `model: orchestration runtime`; the project deployment in `project.md` carries
  `backends: [codex]`, `model: gpt-5.6-luna`, `effort: max`, `autonomy: full`.

So: no surface refused the policy. The one thing worth flagging is that the operator's real
model is only visible in the project deployment — the global Agents page still shows the
placeholder — which is correct but easy to misread as "unset".
