# Findings ledger — pass 6 (2026-07-16)

Running ledger for this pass. IDs are stable; implementation phase must close every OPEN
item or record an explicit owner ruling. Severity: HIGH (breaks a core flow), MED (wrong or
misleading behavior), LOW (polish/debt). Status: OPEN / FIXED / RULED / WONTFIX.

## FINAL STATUS (end of implementation, branch pass6-implementation-2026-07-16)

FIXED + verified: F-SPAWN1 (watcher fd prune), F-SPAWN2 (terminal-race completion), F-RUN1
(boot finalizer), F-RUN1b/R6-5 (demo-run honesty: boot finalize + honest home metric),
F-GH3 (server push before review PR — live PR #25), F-GH4 (empty-diff surfaced), F-DOCKER1
(codex auth.json validation + codex-home subdir + docs), F-RBAC1/R6-2 (owner-exception
accept), F-RBAC2/R6-3 (archive read-only), F-UI1 (packet confirm label), F-ENV2/G1
(migration-gap doc).
RULED/verified-on-main: F-RBAC3/R6-4 (drag=accept already implemented), F3 stage-gating &
F4 skill-isolation (already enforced), F-DOCKER3 (failure classification already present).
Working-as-designed: F-SPAWN4/A5 (baseURL dev-inference), F-ENV1 (stay-on-main ruling).
Residual (documented, low-risk): F-DOCKER2 (Linux Landlock — untestable here), F-PARITY1
(codex Live-panel usage cosmetic), F-GH1/F-RES1/F-RES2 (needs a reachable MCP/live PAT to
re-exercise; seeded fakes kept honest), A3 (crash reason surfaced via A2 escalation packet).

Companion docs: `canon.md` (product rulings), `original-intent.md` (PRD/mock),
`architecture.md` (code map), `ui-walkthrough.md` (per-page UI state).

## Environment / boot

- **F-ENV1 · HIGH · OPEN — main does not boot against a DB touched by the codex branch.**
  The unmerged `codex/e2e-product-hardening-2026-07-13` squashed migrations into
  `0001_baseline.sql` and stamped the shared dev DB; main's runner then re-applies
  `0001_app_foundation.sql` and dies ("table users already exists"). Owner ruled 2026-07-16:
  stay on main; DB restored from `projection.pre-baseline-20260715-2320.sqlite`; baselined DB
  preserved as `projection.baselined-codex-20260716.sqlite.bak`. Follow-ups: (a) decide fate of
  the codex branch (reference-only per ruling), (b) make the migration runner fail with a
  actionable message when `schema_migrations` names don't intersect the on-disk chain.
  Note: restored DB contains rows for migrations 0015–0023 that don't exist on main (additive;
  harmless to the runner, but schema is a superset of main's chain).

- **F-ENV2 · MED · OPEN — migration numbering gap on main:** `db/migrations/` jumps
  0006 → 0008 (no 0007). Harmless to the runner but confusing; document or renumber.

## Runs / operator

- **F-RUN1 · HIGH · OPEN — real runs orphaned mid-flight are never finalized.** Verified in
  code: the operator single-flight lease is a process-local Map
  (app/server/runtimes/operator-run.server.ts:116-190); agent_runs rows are written
  `state='running'` and boot recovery (run-recovery.server.ts) only handles
  `state='finished'` unreacted runs. A server crash/restart mid-run leaves the row
  `running` forever → permanent "agent working"/"N runs active" badges and a ticking
  ELAPSED with no live process. Fix: boot-time finalizer that flips running rows without a
  live in-process registration to `error` (reason: interrupted by restart) and lets the
  operator raise a recovery packet — mirroring what run-recovery does for finished runs.

- **F-RUN1b · owner question — seeded demo runs animate the UI as if real.** The 4
  `running` rows in the current DB are all `run_seed_*` (`simulated=1`); the seed-resumer
  (boot "Phase 8") deliberately re-registers their live lines each boot so Viberr Core always
  looks alive (home "3 runs active", Live tab, ticking elapsed with TURNS/TOKENS 0). This is
  deliberate walkthrough dressing, but it renders indistinguishably from real work and sits
  in the primary workspace permanently. Ask owner: keep as-is, visually mark simulated runs,
  or stop counting them in "runs active"/Live rollups.

- **F-RUN2 · MED · OPEN — codex quota exhaustion produced blocked decisions (Jul 12) and,
  per memory, may persist until ~Aug 2026 for the CLI account.** Live phase must test codex
  end-to-end and, if quota is still exhausted, define the product behavior for quota-blocked
  runs (current: "Blocked — decision needed: pick a recovery path" packet — reasonable).

## Agent spawning (discovered live, pass-6)

- **F-SPAWN1 · CRITICAL · PATCHED (needs test + review in impl phase) — watcher fd explosion
  breaks ALL agent spawning on macOS.** The chokidar watcher on `${dataRoot}/projects` held an
  open fd for EVERY file in EVERY historical `tasks/<KEY>/workspace/` clone (~550/workspace;
  measured 11,342 fds with ~20 accumulated workspaces). Once new pipe fds number ≥ OPEN_MAX
  (10,240) macOS `posix_spawn` file actions fail → every Claude/Codex SDK child spawn dies
  instantly with `spawn EBADF`. So the app progressively kills its own agents as delivered
  tasks accumulate — this is why agent runs that worked in passes 1–4 were all dead today.
  Patch applied 2026-07-16 (this pass, on main): `shouldPruneSubtree` in
  app/server/files/file-watch.service.server.ts prunes dirs deeper than the task dir from the
  watch tree (fds 11,342 → 541; operator runs work again). Implementation phase must add a
  regression test (watch tree must not descend into workspace/) and consider workspace GC.
- **F-SPAWN2 · HIGH · OPEN — an instantly-failing run escalates nothing (race).** The operator
  attaches its completion callback via `chainRunCompletion` AFTER `startRun` returns
  (operator-run.server.ts:703-713); a run that errors within milliseconds completes before the
  chain is attached → no escalation packet, no timeline event, no notification: the task
  silently sits at waiting=human with an empty timeline. Same-class risk wherever completions
  are registered post-start (specialist path registers via startRun input? verify). Fix:
  chainRunCompletion must fire immediately when the run is already terminal.
- **F-SPAWN3 · MED · OPEN — the crash reason is not persisted anywhere.** `agent_runs` has no
  error column and a crashed-at-spawn run writes zero run_log_lines; the only trace is a
  server-console log line. Users see "error" with no cause. Persist a terminal error
  reason/classification on the run row (quota/auth/spawn/crash) and render it in the run panel
  (runFailureReason already classifies — it just has nothing durable to read for spawn crashes).
- **F-SPAWN4 · LOW · OPEN — Better Auth boot warning:** "Base URL is not set" logged every
  boot; set baseURL/BETTER_AUTH_URL from env(PORT) or allowedHosts.

## Docker / compose (owner-reported: "codex runs are broken for docker compose")

- **F-DOCKER1 · HIGH · OPEN — codex broken under compose: `CODEX_HOME` override points at a
  directory that is never created or populated.** compose.yml sets
  `CODEX_HOME=/data/runtimes/codex-home` but nothing copies `auth.json` there and no
  `CODEX_ACCESS_TOKEN` is provided; `VIBERR_CODEX_USE_CLI_AUTH=1` makes the runtime registry
  select the REAL codex adapter on a presence-only check (flag set ⇒ real), so runs die with a
  single redacted "Codex execution failed…" line. Evidence: 4 dead run logs
  `docker-data/runtimes/codex/*` from 2026-07-16 07:30–07:34. Fix candidates: create+document
  a mount/copy path for codex-home; add `runtimes/codex-home` to `DATA_ROOT_SUBDIRS`; make
  adapter selection validate usable auth (fail fast with an actionable packet, not a redacted
  line); surface auth state on a diagnostics surface.
- **F-DOCKER2 · MED · OPEN — codex sandbox modes likely need Landlock/`codex-linux-sandbox`
  inside the container** (`read-only`/`workspace-write`); untested; probable next failure after
  auth is fixed. Verify in-container and either ship the sandbox helper or degrade explicitly.
- **F-DOCKER3 · LOW · OPEN — stderr redaction makes every codex failure look identical.**
  Redaction is deliberate (secrets), but at minimum classify auth/config/sandbox failures into
  distinct user-facing reasons.

## GitHub

- **F-GH3 · HIGH · OPEN — the governed delivery chain has no owner for the push step.**
  Live evidence (VTL-2, 05:36–05:45): codex Developer (caps commit-push-branch=direct,
  open-review-pr=direct) committed locally in its workspace but declined remote delivery
  (its sandbox has no network; persona says "Viberr owns remote delivery");
  `reconcileWorkspaceDelivery` only READS the workspace (never pushes); the review-boundary
  `openReviewPrBestEffort` got GitHub 422 (branch == main) → logged
  `review PR not opened / nothing_to_review` and swallowed it — no packet, no timeline
  entry, no notification, no retry (PR-open fires ONLY at the review transition;
  Reconcile adopts existing PRs but never creates). Fix shape: at the review boundary,
  if task.md has reconciled local commits but the remote branch has no diff, PUSH the
  workspace branch via the PAT (system_delivery authority) before opening the PR, and
  surface any residual empty-diff as a packet, not a log line.
- **F-GH4 · owner question — acceptance with NO PR reaches Done silently.** Accepting the
  completion on VTL-2 (no PR ever existed) moved it to Done with timeline copy "(no linked
  pull request)" — honest but frictionless: the work is NOT on main and nothing tracks the
  un-merged branch afterwards. Options: block acceptance when commits exist but no PR
  (strict), require an explicit "accept without PR" confirm (middle), keep as-is (current).
  Related to (rejected) pass-5 D11; the no-PR-at-all case was never explicitly ruled.

- **F-GH1 · MED · OPEN — no credential configured anywhere** (org connections = 0, Viberr Core
  shows "no credential"): branch/PR sync offline on every project. Live phase must attach a
  PAT (org connection + project credential) and verify: branch creation, PR open, accept→merge,
  reject flow, merge-pending fallback when GitHub unreachable.
- **F-GH2 · LOW · OPEN — Open on GitHub / PR links** to verify once credentialed (dead-link
  audit: PR chips #318/#311/#298/#287 on seed tasks).

## Resources / agents

- **F-RES1 · MED · OPEN — seeded MCP server is a fake URL** (`docs-search` →
  https://mcp.example.dev/docs, unreachable · checked 3d ago). MCP wiring needs a live test
  with a real server; also decide whether seed data should ship a working example instead of
  a permanently-red row.
- **F-RES2 · LOW · OPEN — KB "read live · re-scanned <date>"** — verify re-scan actually
  re-indexes (PRD flagged fake Re-scan toasts in the mock era; architecture.md says scripts/
  rescan.ts exists).

## Parity / UI polish (from live testing)

- **F-PARITY1 · LOW · OPEN — codex Live panel shows TURNS/TOKENS 0 mid-run** while claude
  streams them; codex usage folds only at completion. Cosmetic; make the panel honest
  ("usage at completion" for codex) or stream codex usage if the SDK exposes it.
- **F-UI1 · LOW · OPEN — decision-packet resolve action-bar text overlaps itself**
  (the picked-option label renders twice on top of itself in the resolve row). VTL-1 packet.

## RBAC / role bindings (owner: "we will need to touch role bindings")

- **F-RBAC1 · canon contradiction (needs owner ruling) — accept-completion tier.** Owner ruling
  D1 (pass-5 lineage, explicit): a Contributor who owns the task may accept its completion.
  Main enforces Accept completion → Done at Maintainer+ (policy matrix row shows
  contributor —). One of them must win; if D1 stands, `ACTION_ROLES.acceptCompletion` needs an
  owner-scoped exception path.
- **F-RBAC2 · canon contradiction — archive semantics.** Owner decision (pass-3 D): archive =
  hide-only, restorable. Pass-5 working ruling D6 (not owner-confirmed): archived = read-only
  enforced. Main behavior to verify; needs a ruling before implementation.
- **F-RBAC3 · canon contradiction — human move-into-Done.** Pass-4 validated H4: a human
  dragging a Review task to Done = acceptance. Pass-5 D7/D11 (not owner-confirmed): acceptance
  only via Review queue; Done blocked until real merge. Verify main; needs ruling.
- **F-RBAC4 · LOW — org-admin emergency override (owner ruling D2)** — verify main implements
  org-admin project override; if absent, implementation item.

## Product-canon notes for the test phase

- Operator: one per active task; requests transitions with evidence; never codes; full-autonomy
  Direct completion is the single audited exception.
- pr.state vocabulary is closed; `accepted` ≠ `merged` (merge-pending is a legit state).
- Simulated runtime exists (offline backend) — pass-5 D12 wanted simulated governance evidence
  banned; on main, simulated-agent canned reports can advance real boards (architecture.md
  "suspicious" list). Needs ruling for main.

## Deferred cluster from 2026-07-13 ultra review (applies to the codex branch, but re-check main)

- GitHub delivery: headSha/merge deadlock class — verify main's `mergeTaskPr` path.
- Dispatch lifecycle: lease/restart recovery (ties into F-RUN1).
- Reviewer governance: reviewer verdict gating.
- codex argv: `--config` argv secret leak class — check main's codex adapter argv construction.
