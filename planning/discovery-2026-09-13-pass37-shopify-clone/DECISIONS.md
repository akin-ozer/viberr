# Owner decisions taken during pass 37

## D37-1 — A dependency hold is a HARD GATE, one spelling (2026-09-13)

*Context.* F37-2: `blockedBy` held nothing. Viberr wrote "Held until every entry is done;
Viberr releases it then" and 1.9 s later started a Codex run that designed and committed the
whole identity service onto a pushed branch cut from a `main` predating its dependency.

*Ruling.* A held task refuses **every** agent dispatch, at the same chokepoint and in the
same shape as the archived/terminal gate (ruling 177). No supporting-run carve-out, no
advisory mode. The words on the board become true.

*Accepted cost.* A held task can do no preparatory work at all — no reading, no drafting —
until its dependencies are satisfied and viberr releases it.

*Implementation note.* One gate in `startAgentRun`, beside the existing closure gate, with a
refusal sentence that names the unsatisfied entries; every door that dispatches goes through
it. The operator must not be woken to burn a paid turn restating the hold.

## D37-2 — MCP coverage uses a credential-free server (2026-09-13)

*Context.* The controller refused to provision an MCP server because every useful one needed
a token it may not accept in chat (correct behaviour — ruling: secrets never travel through
the controller conversation).

*Ruling.* Add a local, credential-free MCP server in Org settings, then have the controller
grant it to a profile. This exercises create → mark write tools (ruling 176) → grant → mount
→ enforce without a secret. The sealed-credential path is out of scope for this pass.

## 2026-09-13 · Owner: fix the environment, not the clone (ruling 196)

**Background I put to the owner.** The agents' container holds node, npm and git and
nothing else — no pnpm, no make, no Docker, no turbo, no psql — while the clone the
controller designed is a pnpm + turbo monorepo with a root Makefile and a Docker Compose
stack. 75 `command not found` lines, a root Makefile whose every target exits 127, a
required reviewer chartered to `make up` that can therefore never approve, and one Code
Reviewer verdict claiming a pnpm test run that never happened (F37-13, F37-14).

**Three options offered.** (a) Re-platform the clone onto what the host can run — npm
workspaces, node's own test runner, per-service SQLite, one node script starting every
service on its own port; keeps the whole product bar and every part of it executes.
(b) Keep pnpm/turbo/Docker and accept that nothing is ever executed here; verification
stays static review. (c) Add pnpm and make to the viberr image — unblocks installs, builds
and unit tests, but not Docker, so the Compose stack and a real Postgres still cannot run.

**Owner chose (c)**, and separately chose "add the cheap ones (make, pnpm, curl)" for the
viberr image question. Both answers point the same way: fix the environment, leave the
clone's design alone.

**Consequences I own and am carrying out.**

- `make`, `curl` and `pnpm@12.4.1` are in the image (ruling 196). Verified live on
  `/resources/health`: `make 4.4.1`, `pnpm 12.4.1`, `curl 8.14.1`, `docker null`.
- **Docker is still absent and is not coming.** So the Integration Verifier's charter —
  "Cold start … `make up`, everything healthy … Report `approve` only when the stack came
  up cold" — is still unsatisfiable, and SHOP-7 is still held by it. That is now a charter
  problem with a named owner (the controller wrote it) rather than an invisible one, and
  ruling 193's doctrine arm is what puts it in front of a human instead of looping the
  deliverer. I am telling the controller, with the measured inventory.
- The clone keeps `pnpm-lock.yaml` and `packageManager: pnpm@9.15.4` while the image ships
  pnpm 12. A repo pinning its own version reaches it with `npx pnpm@9.15.4`; the SHOP-6
  "Lockfile ownership" packet is now answerable either way, because a pnpm exists to run.
