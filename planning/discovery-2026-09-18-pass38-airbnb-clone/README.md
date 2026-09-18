# Pass 38 — Viberr builds an Airbnb clone

2026-09-18. Viberr's own controller was given one goal (`goal-1.md`) in a fresh
instance-scoped conversation and built a short-term-stay marketplace in
`akin-ozer/airbnb-clone` through Viberr's own machinery. I drove the controller, watched
live, rejected pull requests on purpose, let one diverge after review, and fixed what
broke in Viberr. I wrote none of the clone.

Two lenses carried the whole way, because both were unswept:

1. **Does Viberr enforce what it tells agents it is enforcing** — declared path sets,
   don't push, don't open a PR, file leases, held tasks refusing dispatch, withheld
   repo-write, denied tools. Ruling 186 was that shape and it was a HIGH.
2. **One fact, several surfaces: do they agree** — rulings 338 and 346, both found by
   accident last pass.

| file | what it is |
|---|---|
| [`goal-1.md`](goal-1.md) | the goal, verbatim |
| [`FINDINGS.md`](FINDINGS.md) | confirmed findings, each with its measurement, refutation attempt, fix and red-proof |
| [`CANDIDATES.md`](CANDIDATES.md) | every candidate, including the ones that died and what killed them |
| [`LENS1-ENFORCEMENT-SWEEP.md`](LENS1-ENFORCEMENT-SWEEP.md) | the enforcement-claim sweep (agent-written; every claim verified before it became a finding) |
| [`LENS2-SURFACE-AGREEMENT-SWEEP.md`](LENS2-SURFACE-AGREEMENT-SWEEP.md) | the surface-agreement sweep (agent-written; same rule) |

Rulings from **347** in `docs/architecture/decisions.md`. Fixes on
`pass38/airbnb-clone-fixes`.

## Setup the controller built for itself (one turn, unaided)

Project `Airbnb Clone Marketplace` / slug `airbnb-clone-marketplace` / key `BNB`, on
`akin-ozer/airbnb-clone`, policy `balanced`, six stages (Triage, Design, Build, Review,
Verify, Done; `verify → done` human and locked). Three knowledge bases
(`airbnb-clone-architecture`, `-conventions`, `-rulings`), five skills, six agent
templates, all Claude / `opus` / `high` because Codex was out of quota until Sep 19.
Its stack decision, made from the measured host (no docker, no python, no go, no
browser): SQLite through `node:sqlite`, one file per service, Node child processes
supervised by `scripts/stack.mjs` behind `make up`; the booking service owns both
availability and reservations so a hold is one transaction.
