# Pass 12 — Implementation PLAN (2026-07-24)

Branch: `pass12/product-fixes` off `main` @ 0981cfa. Standing rulings: NO incremental
migrations (schema changes squash into `db/migrations/0001_baseline.sql`; upgrade = wipe
projection.sqlite + re-seed); breaking changes allowed; tests may be touched critically.
Baseline: 1472/1473 unit green (the 1 failure is F12-01, a flake). Build assumed green.

## Priority tiers (implement in this order)

### Tier 1 — correctness bugs (real defects, do first)
- **AO-1** `staged_outcomes` unreachable on boot-recovery (Claude verdicts lost after restart).
  Wire `outcome_key` through `agent_runs` + `recoverUnreactedAgentRuns` so the staged lookup
  actually fires post-restart. Add a restart-recovery test.
- **AO-2** tokenless cross-boot operator-lease release race → double-drive. Route the release
  through the stale-release token guard. Concurrency test.
- **DG-1** merged cached PR reused (pr-open.server.ts:142): treat `merged` like `closed` so a
  reworked branch opens a FRESH PR. Regression test (merged→rework→new PR).
- **DM-1** `validation` projects stale file value while `validation_block_reason` is re-derived
  → can show healthy + a block reason. Recompute both at the same site. Test.
- **DM-3** `resetStore` never clears `scope_violations` (+ **F12-01 seed** leftover
  `user_prefs`) → phantom badges after re-create. Scope the reset. Test. (Cross-check the
  MCP-server / GitHub-connection asymmetry — see owner Q3.)
- **F12-01** kb-watch flaky test: make the re-index assertion deterministic (monotonic
  counter / content hash / real clock tick, not same-ms ISO compare).

### Tier 2 — honesty / silent-failure / observability
- **DG-5** PR-open auth_failed/network_unavailable at Review is only a log line → surface as a
  timeline event + notification (match the push-failure treatment).
- **DM-2** KB watcher: no error recovery + invisible to /resources/health. Add health parity +
  handle recovery (dead handle currently cached forever).
- **DG-3** reconcile poller: unbounded provenance rows every 5 min (retention/skip) + a
  rate-limit 403 can auto-open a bogus `repo` scope violation (distinguish 403 causes).
- **RU-2** create-profile modal offers unavailable backends → gate the picker to available.
- **RU-1** profile overlay toasts on no-op submit → only toast on real change.

### Tier 3 — dead code / polish / noise
- **DG-4** dead `up_to_date` push variant. **AO-3/DM-*/DG-6** stale comments. **F12-03** remove
  empty `test-support/livesix/`. **F12-02** favicon.ico 404 spam (add public/favicon.ico or a
  handleError that drops routine 404s). **RU-3** last role-literal gate → roleCan.
  **RU-4** notifications hard cap at 200. **seed** password literal tripled, dead `livessix`,
  operator-prose duplication (validate if intended). **rbac** ALLOWED_AUTH_PATHS zero test
  coverage → add tests; buildAuthOptions docstring references a nonexistent script.

### Tier 4 — OWNER-RULED (2026-07-24, implement per ruling)
- **F12-05** autonomous Done-but-unmerged → **RULING: poller nudges human to merge.** Keep
  autonomous self-accept; the reconcile poller (+ a notification) must surface a Done/accepted
  task whose PR is still OPEN ("merge pending") so a human finishes the merge. Nothing rots silently.
- **DG-2** force-accept → **RULING: add admin force-accept.** Wire an explicit, audited,
  admin-only force-accept that bypasses the required-reviewer gate (surface it in the UI where a
  task is stuck on an un-recordable required reviewer). Keep the `force` param; give it a real caller.
- **DM-3b** --reset scope → **RULING: just fix the leak.** Add `scope_violations` + `user_prefs`
  to the existing `resetStore` wipe (fixes phantom badges). Leave the MCP-vs-GitHub asymmetry as-is.

## Validation gate (per the goal — no cut corners)
After each tier: `npm test` + `npm run build` green. Then LIVE re-validation in the browser of
the specific fixed behavior (screenshots), re-running the relevant use case against fixed code.
Final: full suite green, build green, adversarial self-review (Workflow) of the fix PR, then a
PR on akin-ozer/viberr.

## Open owner questions (blocking Tier 4)
1. **Autonomous Done semantics (F12-05):** autonomous operator marks a task Done but the PR
   stays OPEN ("merge pending") because merge is always-human. Intended, or should Done⇒merged
   (block autonomous completion until a human merges), or should the poller nudge the human?
2. **Required-reviewer override (DG-2):** the `force` acceptance bypass is dead code today, so a
   task whose required reviewer can't record a verdict is permanently un-acceptable. Keep strict
   (remove dead code) or add an admin force-accept?
3. **--reset scope (DM-3):** should a clean-sheet reset also drop scope_violations, user_prefs,
   and admin-installed MCP servers, or preserve them like GitHub connections?
