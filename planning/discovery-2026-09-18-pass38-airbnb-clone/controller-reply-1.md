# Controller reply 1 — 2026-09-18T02:18:56.997Z

Setup is built and BNB-1 is running. Here is the whole shape, and what actually happened.

## The stack I chose, and why

`node:sqlite` on node 26, TypeScript ESM, pnpm workspace, Next.js for the web. That choice is forced by your host and I checked it rather than assumed: `instance_health` reports node 26.9.0, npm 11.19.1, pnpm 12.4.1, git 2.47.3, make 4.4.1, curl 8.14.1 and `docker: null, python3: null, go: null`. `node:sqlite` is built into node 26, so persistence needs no native module and no daemon. The "stack" is a Node process supervisor behind `make up` — real child processes on real ports, real TCP between them — which is a genuine integration surface without a container runtime. No browser is in any gate; journeys are node-driven HTTP against the running server.

**Seven services + the web app**, each one process, one port, one SQLite file: `gateway` 8080, `identity` 8081, `listings` 8082, `booking` 8083, `payments` 8084, `messaging` 8085, `reviews` 8086, `apps/web` 3000.

The one boundary decision worth defending: **availability lives with reservations, in `booking`.** Your invariant is that two guests can never hold the same night. A guarantee spanning two databases needs a distributed transaction and there is none here — so the calendar and the reservation are one context, and a hold on N nights is one `BEGIN IMMEDIATE` against `listing_night PRIMARY KEY (listing_id, night)`. The collision is a constraint violation, not a lost race. There is no read-then-write availability check anywhere in that path, and BNB-5's done signal requires proving it by dropping the primary key and showing the concurrency test go red. Host blocks contend through the same constraint via sentinel rows, so a block racing a booking resolves the same way.

## Stages and policy

`Triage → Design → Build → Review → Verify → Done`. Every boundary is `auto` so the operators keep moving without me; `Verify → Done` is `human` and locked. Required reviewers are declared at both gates: **BNB Code Reviewer** at Review, **BNB Integration Verifier** at Verify — no task is acceptable until the verdict exists on the delivered revision. No agent anywhere holds `merge-pull-request` or `transition-to-done`; both resolve to `human`. Every PR is yours.

## Agent profiles (six, all new)

| profile | stages | what it holds |
|---|---|---|
| BNB Platform Architect | triage, design, build | writes contracts + schemas + `docs/decisions/` |
| BNB Backend Engineer | design, build, review | one service slice per task |
| BNB Frontend Engineer | design, build, review | `apps/web` only, gateway only |
| BNB Infrastructure Engineer | design, build, verify | workspace, supervisor, CI, tracing |
| BNB Code Reviewer | build, review | `report-validation-verdict: direct`, no push, no PR |
| BNB Integration Verifier | review, verify | same, plus cold-stack verification |

**Model policy held everywhere, nothing refused.** All six templates are Claude/`opus`/`high`, all six deployments were created `opus`/`high`, and I moved the **Operator** itself to Claude/`opus`/`high` with autonomy `full`. I'm on `opus[1m]`. Your quota reading confirms the reason: Codex shows `exhausted`, `"try again at Sep 19th, 2026 9:36 AM"` — nothing on this board can touch it.

Two things I did deliberately that you should know about:

- Deployments land with **delivery withheld**; I opened `execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch`, `open-review-pr` and `read-github-api` on the four builders, and only `execute` + `read-github-api` + `report-validation-verdict` on the two reviewers — reviewers run suites but cannot push.
- **I granted no MCP servers at all.** All three that exist (`kb-files`, `kb-architecture`, `kb-conventions`) are filesystem servers pointed inside `/data/kb` with `write_file`/`edit_file` exposed, and the registry itself flags it: an agent holding one could rewrite the knowledge bases and personas Viberr injects into runs — including the rules its own reviewers judge it against. The ruling-176 write-tool guard doesn't cover it, because it only binds runs that *withhold* execute, and my delivery agents hold execute. The knowledge they need is injected directly as KBs instead, which is strictly safer and loses nothing.

Three KBs written: `airbnb-clone-architecture`, `airbnb-clone-conventions`, and `airbnb-clone-rulings` — the last one promoted to the project's **rulings KB**, so its 12 numbered rules reach every run on this board including mine. Five skills: `bnb-service-delivery`, `bnb-web-delivery`, `bnb-platform-infrastructure`, `bnb-delivery-review`, `bnb-stack-verification`.

## The breakdown: 8 chained goals, 30 tasks

1. **Foundation** (4) — bootstrap → shared packages (`db`/`http`/`testing`) → contract primitives (Money, half-open nights, error codes) → the `make up` supervisor.
2. **Contracts & gateway** (4) — identity+listings → booking+payments → messaging+reviews → the gateway trust edge. Contracts freeze here.
3. **Identity** (2) · 4. **Listings** (3) · 5. **Booking, availability & payments** (5) · 6. **Messaging & reviews** (2) — the four delivery chains.
7. **Web surfaces** (6) — shell/auth → search → listing page → booking+payment+trips → wishlists+messaging → host surfaces.
8. **Integration & hardening** (4) — seed → `make journey` → concurrency + failure injection → runbook + cold-start.

## How I'm keeping several agents out of each other's way

Four mechanisms, chosen at design time rather than discovered at review:

1. **Shared surfaces are derived, not edited.** Gateway routes are found by directory scan (`routes/*.route.ts`), the service registry *is* the `stack/*.json` directory, the CI matrix comes from `pnpm -r list --json`, make targets are `make/*.mk` fragments. Adding a service adds files; it never edits a central list. That's why the Foundation chain runs alone first — it exists to delete the contention.
2. **Path sets in every task text**, enforced by the reviewer as a real finding, with `pnpm-lock.yaml` as the standing exception (merge main, regenerate, make it the last commit).
3. **File leases** for what can't be derived. `BNB-1` currently holds the workspace root, the root `Makefile`, `.github/**` and `README.md` — another task's *push* touching those is refused before it reaches GitHub. I'll move the lease to `packages/contracts/**` when the contracts chain opens.
4. **`blockedBy` across chains** for true ordering. The board is enforcing it right now: BNB-2 waits on `goal-1 link 3`, BNB-6 waits on three separate links, BNB-8 on three. Parallelism only opens after contracts freeze, and then four chains run at once without sharing a file.

## One honest risk

`get_github_state` returns `defaultBranch: main` with **zero branches and zero commits** — the repo is unborn. Viberr's branch machinery may not be able to cut `BNB-1` from a `main` that has no ref. I've written that condition into BNB-1's goal text and into the operator's directive: if it fails, the agent stops and reports rather than improvising, and you may need to make the first commit yourself. I'd rather tell you that now than have it surface as a mysterious failed run.

**Running now:** `run_agent_on_task` returned `[done] Operator run started on BNB-1`. Everything else is held by its dependencies and will release itself. Board is `airbnb-clone-marketplace`.
