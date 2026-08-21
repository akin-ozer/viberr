# Improvement backlog + open product questions (critical synthesis, 2026-08-21)

Forward-looking, critical read of the **current shipped** app (main `cdce29c`), from
first-hand code + live UI/browser inspection this pass. Distinct from the pass-22
fix list (which is merged): this is "what to build / what's missing / what needs a
decision" for the NEXT implementation phase. Nothing here is speculative padding —
each item was observed or code-verified.

## A. Genuine gaps — worth building

1. **Browser-agent authenticated browsing (owner's focus area).** OBSERVED LIVE: a
   browser-capable agent (Web Researcher) hitting `github.com/akin-ozer/viberr`
   captured a **404** — the repo is private and the agent's chromium is
   unauthenticated. The browser can only see the **public web**. There is no way to
   hand the agent a logged-in session or inject the project's PAT into the browser
   context. This caps the "capture evidence from a gated page" class of tasks (a PR
   page, a private dashboard, an authenticated app the agent is meant to test).
   → BUILD candidate: an opt-in, capability-gated way to give a browsing agent an
   authenticated context (project PAT for github.com, or a per-task credential the
   human supplies), with the same egress-gating and audit the browser cap already has.

2. **Attachments: no quota / retention / honest truncation.** CODE-VERIFIED: the
   attachments store has no size quota and no retention policy; the list is capped
   (LIST_CAP) so older files are **silently hidden** past the cap rather than
   surfaced as "N more not shown"; and mtime-window attribution can cross-attribute
   files when a deliverer and reviewer save concurrently. Fine for a demo, a real gap
   for long-lived projects with browser agents saving screenshots every run.

3. **Codex-quota exhaustion is only surfaced at run-failure, not at assignment.**
   F22-08 made the failure message honest ("over usage quota, retry <date>"), but the
   operator still ENGAGES a Codex agent and only discovers the quota wall when the run
   fails. There is no proactive "this backend is over quota" signal at assign/run time.

## B. What needs a decision (design/robustness)

4. **docker-data + SQLite WAL on VirtioFS is fragile.** This bit HARD twice this
   session (`database disk image is malformed` → crash-loop). The writer-lock guards
   dual *writers*, but (a) there's no graceful WAL checkpoint on shutdown, so a
   container recreate can open a bad WAL state, and (b) a malformed DB is a fatal
   crash-loop with no self-heal — recovery is a manual `sqlite3 .recover`. For a
   self-hoster on Docker Desktop/macOS this is a real footgun.
   → DECISION: add `PRAGMA wal_checkpoint(TRUNCATE)` on SIGTERM and/or a boot
   self-heal (auto `.recover` into a fresh DB when integrity fails, since projections
   rebuild from `.md` and only auth/PATs need salvaging)?

5. **Seed defaults the Developer to Codex.** Makes the app undemoable / untestable
   end-to-end without an active Codex quota (the whole "codex vs claude parity" is
   unverifiable live right now). → DECISION: Claude-default seed, or a quota-aware
   fallback, or leave Codex-first by intent?

6. **Residual layering (scoped out of #183).** `server/tasks/specialist-run` and
   `operator-actions` still import `effectiveProfileView` from `features/agents` — the
   full display-view-engine relocation is a separate, larger refactor left for a
   deliberate pass.

7. **Held items from prior passes (owner's call):** D7 / D10 / D11 / D12.

## C. Honest positives (do NOT "fix" these)

- **UI/UX is coherent and holistic** — audited Home, Board, Agents, Policy, GitHub,
  Activity, Review live: consistent header/breadcrumb/nav, right-rail state cards,
  color-coded capability buckets, and genuinely good empty states. No incoherence found.
- **RBAC + agent-capability model is clear and server-enforced** (Deniz's create-task
  was blocked and audited; the two-surface Policy page reads cleanly).
- **Operator behaves correctly** — triages, selects the right agent (engaged the
  Web Researcher for a browser task, the Codex Developer for delivery), respects
  read-only constraints, and raises recovery packets (e.g. the #190 rejection).
- **Browser-evidence pipeline works end-to-end** — chromium screenshot → attachment →
  thumbnail → lightbox (full-res) → F22-11 close-focus, validated live on shipped code.

## D. Open questions for the owner (surfaced separately, with background)

- Q1 — Browser-agent **authenticated browsing**: in scope, or deliberately public-only?
- Q2 — **Codex-quota** handling: seed default backend + a proactive at-assignment
  "backend unavailable" signal?
- Q3 — **WAL/VirtioFS robustness**: worth a graceful-checkpoint + boot self-heal so a
  self-hoster can't hit an unrecoverable crash-loop?

---

## Implementation status (2026-08-21, owner-approved)

**DONE (branch feat/pass22-robustness-browser-auth, tested):**
- **F1 — DB robustness.** The WAL checkpoint on SIGTERM already existed (`shutdownDatabase`, wired at sse-broker). Built the missing half: `app/server/db/self-heal.server.ts` — at boot, `PRAGMA quick_check`; if malformed, salvage every readable non-projection row (auth/PATs/audit survive on healthy pages), move the corrupt file aside (`.corrupt-<stamp>`), rebuild a fresh migrated DB, leave `provenance` empty so the rescan re-projects the `.md` files. Wired into `bootServer` before `getDb()`. Turns the crash-loop I hit into automatic recovery. 8 tests (no-false-positive on healthy, salvage on partial corruption, recovery-to-working on catastrophic corruption, deterministic stamp).
- **F2 — seed Developer → Claude.** `agent-catalog` developer now `backends: ["claude","codex"], model: "sonnet"` (Codex still offered). The DEMO seed pins the developer to Codex (test-only) so the mock dataset still exercises both backends + the drift tests. Tests updated.
- **F3 — proactive availability signal.** `listDeployedSpecialists` threads `model_availability` marks → `DeployedSpecialistView.modelUnavailable` → the run control (`execution-profile`) renders a warning on the delivering-agent card BEFORE a run is spent, with the provider's redacted reason. NOTE (important): quota/auth are TRANSIENT and deliberately NOT persisted as availability marks (`model-availability.server.ts:27`), so this covers the unsupported-model class; the QUOTA case is handled by F2 (Claude default) + the F22-08 run-failure message. Tests: server (mark surfaces) + UI (warning renders / absent when available).

**F4 — authenticated browser: BLOCKED on a design fork (needs owner input).**
Discovered while designing it: a GitHub **PAT authenticates the API (`api.github.com` via `Authorization` header), NOT the github.com WEB UI** (web auth is a session cookie). So "inject the project PAT for github.com" would NOT let a browser view the private-repo web page (the 404 I saw) — the PAT is the wrong credential shape for web browsing. The feature splits by ACTUAL use case, each a different design:
  1. **Authenticated API reads** (repo/PR JSON): a tool/`fetch` with the PAT header — NOT the browser; small, safe.
  2. **Private github.com WEB pages**: needs a real github.com session (OAuth/cookie), which viberr does not hold — out of reach without a new GitHub OAuth-for-browsing flow.
  3. **A gated app the agent is testing** (dashboard / staging): a per-task, human-supplied credential injected as scoped cookies/headers for allowed origins only — a real, security-sensitive feature (the browsing agent can read/exfiltrate what's injected; needs origin-scoping, no-logging, egress-gating, a new capability + UI).
Rushing (1)-shaped code under a (2)/(3) premise would be a corner-cut. Recommend the owner pick the target use case; then F4 gets its own focused PR with a credential model + security review.

---

## Pre-commit adversarial review of F1-F3 (11 findings, addressed)

A 3-lane fable/max review (each finding verified) ran before commit and caught **2 HIGH data-loss bugs in the first-cut F1 self-heal** — the reason F1 was fully rebuilt:

**F1 (rebuilt):**
- HIGH — "projections rebuild from empty provenance" was FALSE: the rescan short-circuits on the projection tables' OWN content_hash, so salvaging them meant a damaged sibling (project_members → member-only projects inaccessible; task_events → empty timelines) was never rebuilt. Fixed: EXCLUDE the file-derived tables (projects, project_members, task_projections, task_events, diagnostics) from salvage so they're empty and the rescan re-projects them (mirrors rebuild.server.ts's drop list).
- HIGH — deleting the `-wal` destroyed the newest sessions/PATs (the module's founding-incident data). Fixed: COPY the `-wal`/`-shm` aside (preserved), drop the stale live sidecars, atomic rename.
- MEDIUM — false-positive heal on I/O/permission errors (EACCES) nuked a healthy DB. Fixed: `projectionDbState` distinguishes `corrupt` (quick_check fail / SQLITE_CORRUPT/NOTADB) from `unreadable` (never heals); busy_timeout on the probe.
- MEDIUM — `.all()` lost a whole table on one bad page + OOM'd on large tables. Fixed: `iterate()` streams row-by-row, keeping the healthy PREFIX.
- MEDIUM — not crash-safe. Fixed: build the replacement at a TEMP path in one transaction, then atomically rename over the original (untouched until the swap).
- LOW — dropped rows were invisible. Fixed: a `skipped` count in the result + boot log.
- Tests rewritten (9): detection discrimination, no-false-positive, prefix salvage, excluded-tables, catastrophic recovery + WAL preservation, deterministic stamp.

**F2:** MEDIUM — a codex-only fresh install now needs the admin to flip the profile (accepted tradeoff, noted in the ruling comment). LOW — the demo model half is now pinned by a test.
  - **KNOWN LIMITATION (documented, not fixed):** a store installed via `npm run seed` under the OLD catalog and then upgraded does NOT auto-converge to the Claude default — `runSeed` writes the template with `kbGrants:true` and never records it in the shipped-assets manifest, so boot's refresher (which ships `kbGrants:false`) treats it as a human edit. FRESH `npm run seed` installs and the docker-compose upgrade path (the live deployment, verified boot-written) DO converge; only the old-seed→npm-seed-upgrade path is affected, and it's recoverable (re-run seed, or flip the backend in the editor). A real fix needs a design decision on the seed-vs-boot `kbGrants` divergence (refreshing a seed file to boot's variant would DROP its KB references), so it belongs in its own pass, not a risky patch here.

**F3:** MEDIUM — the availability warning now renders on REVIEWER rows too (their Run buttons spend runs), not only the delivering card. LOW — the test fixtures now use a real model-unsupported reason (quota is never marked).
