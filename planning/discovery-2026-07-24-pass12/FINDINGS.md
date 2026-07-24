# Pass 12 — Findings (2026-07-24)

Base: `main` @ 0981cfa. Severity: HIGH (correctness/security/data-loss) · MED
(wrong behavior, degraded UX, test-integrity) · LOW (polish/noise/dead code).
Status: OPEN / CONFIRMED / FIXED. Each finding is self-contained for an implementer.

Baseline: full suite **1472/1473 pass**; the single failure is a FLAKE (F12-01),
green on `main` in isolation. Build assumed green (verify before implementation).

## IMPLEMENTATION STATUS (pass 12, branch pass12/product-fixes)

**FIXED + tested:** DG-1 (merged-PR reuse), DG-2 (admin force-accept — RBAC action +
server fn + route + task-detail UI + audit), DG-3 (rate-limit-403 vs scope-403 +
poller provenance retention), DG-4 (removed dead `up_to_date` push variant), DG-5
(PR-open failures surfaced at Review), AO-1 (staged-outcome survives restart via
persisted outcome_key), AO-2 (cross-boot lease drain guarded — reasoning + suite green),
AO-3 (fixed stale "supporting→verdict on" + "no force bypass" comments), DM-2 (KB watcher
health parity + self-heal), DM-3b (reset clears scope_violations + user_prefs),
F12-01 (deterministic kb-watch test), F12-05 (poller merge-pending nudge). Broadened
`directiveRequestsDelivery` (AO-5 regex). Owner rulings applied (F12-05/DG-2/DM-3b).

**TRIAGED — NOT A BUG:** DM-1 (validation vs validation_block_reason are orthogonal by
design: work-health vs review-gate; acceptance gates on the block reason, so a stale
`validation` can't bypass the gate — "healthy + blocked" is legitimate).

**VERIFIED-BENIGN (no change):** duplicated OPERATOR_AUDIT_ACTOR (two identical
`{userId:null,label:"operator"}` consts; dedup risks a task-actions↔operator-run import
cycle for zero behavioral gain).

**Polish cluster (subagent):** F12-02 (favicon 404 via handleError), F12-03 (rm
test-support/livesix/), RU-2 (create-profile backend availability), RU-3 (role-literal→
roleCan), RU-4 (notifications truncation surfacing), ALLOWED_AUTH_PATHS test coverage,
buildAuthOptions docstring.

**LOW residuals accepted (noise, no user impact):** AO-5 batch remainder (near-open resume
confinement edge case, "coordinating model" copy, Codex packet options `detail`, partial-
react replay gap), DM-5 residuals (dual user tables, legacy json cols — pre-prod schema),
DG-6 stale comments, RU-1 (profile toast-on-no-op — subagent may cover), RU-5.

---

## CONFIRMED in main context

### F12-01 (MED · test-integrity) — kb-watch live-watcher test is timing-flaky
`app/server/files/kb-watch.service.server.test.ts:117` asserts
`after.last_indexed_at` !== `before.last_indexed_at` after a debounced KB re-index.
Under full-suite load the re-index lands in the **same millisecond** as the initial
index, so the ISO-string timestamps are equal and the assertion throws
(`expected 'X' not to be 'X'`). Passes 3/3 in isolation; failed 1× in the full run.
**Fix:** don't compare wall-clock ms. Options: poll until `last_indexed_at` advances
with a real clock tick, assert on a monotonic index counter / content hash, or advance
a fake timer so the two indexings can't collide. Must be deterministic.
Evidence: baseline-test.log line 1056-1063.

### F12-02 (LOW · noise) — /favicon.ico 404 spam on every document load
Browsers request `/favicon.ico` by default; the app only serves `/favicon.svg`
(`public/favicon.svg`, linked in `app/root.tsx:37-39`). React-Router has no `.ico`
route AND `app/entry.server.tsx` has no `handleError`, so every `/favicon.ico` request
SSR-renders the full root ErrorBoundary 404 and logs a server error — spam from Safari
and any non-SVG-favicon client on every page load. **Fix:** add `public/favicon.ico`
(or a tiny catch route) so the default request resolves; consider a `handleError` that
drops routine 404s. Cosmetic but pollutes real error logs.

### F12-03 (LOW · dead code) — empty test-support/livesix/ directory
`test-support/livesix/` is an empty dir (0 files) with zero references anywhere in
the tree. **Fix:** remove it.

### F12-04 (LOW · boot warning) — Better Auth "Base URL is not set"
Boot logs `[Better Auth]: Base URL is not set. Set the baseURL option or
BETTER_AUTH_URL env...`. Without it, origin is derived per-request; callbacks/redirects
can misbehave behind a proxy. Confirm whether local-dev-only is acceptable or set a
sane default. (Cross-check with rbac-auth-org.md P11-03 note.)

---

### F12-05 (MED · autonomy/consistency — OWNER QUESTION) — autonomous "Done" leaves PR unmerged
Live-observed (UC-08): an Autonomous-preset operator (`completion-for-acceptance:direct`)
self-accepts a task to **Done**, but because `merge-pull-request` is an always-human invariant
(app/shared/capabilities.ts ALWAYS_HUMAN), the actual GitHub PR is NOT merged — it stays OPEN
in "merge pending". Result: a Done task with an unmerged, dangling PR (VA-1 → PR #93 OPEN).
Human acceptance (UC-11, PR #91) DOES merge. So "Done" means different things by preset.
**Owner decision:** is autonomous-Done-but-unmerged intended (autonomy stops short of the
irreversible merge, human finishes the merge), or should autonomous completion be blocked until
a human merges (so Done always ⇒ merged), or should the reconcile poller surface the dangling PR
as needing a human merge? Currently nothing nudges the human to finish the merge.

## Bugs the LIVE re-validation caught in my OWN pass-12 fixes (both fixed + now tested)

- **SELF-1 (task-detail 500):** the DG-2 UI referenced `onForceAccept` in JSX but never
  destructured it from `GithubTrace`'s props → `ReferenceError: onForceAccept is not defined`
  → every task with a non-null blockReason 500'd. The component tests passed because none
  rendered a blocked task. FIXED (destructure) + a new GithubTrace force-accept component
  test (renders the button on admin, hides it otherwise). LESSON: cover the new render branch.
- **SELF-2 (pr-open type error):** splitting the `if (live.ok)` block in the DG-1 fix broke
  TypeScript's narrowing for the subsequent `live.kind`/`.status`/`.message` error path.
  `npm run build` (esbuild) does NOT typecheck, so it was green while `npm run typecheck`
  (tsc) failed. FIXED (single `if (live.ok) {…} else if …` so narrowing holds). LESSON:
  `npm run typecheck` is a REQUIRED gate — build passing ≠ types passing.

## Findings candidates from discovery subagents (to be triaged/merged)

### seed-testing-infra.md (10 candidates — strongest)
- `seed --reset` leaves demo `scope_violations` + `user_prefs` rows behind → phantom
  Settings badge if viberr-core is recreated. (verify)
- `npm run seed:demo` ships broken in the Docker image (test-support/ not copied in). (verify)
- Agent-profile files are outside BOTH drift guards and their `.loose()` schema can't
  capture unknown keys → silent agent-profile schema drift. (verify)
- Operator prose duplicated: `assets/operator.definition.md` (consumed via ?raw by
  default-assets.server.ts) vs catalog `agent-catalog.server.ts` `desc` — flagged
  divergent. NOTE: assets is the runtime system-prompt body, catalog is the card blurb;
  may be by-design — TRIAGE whether they SHOULD match.
- Org seed clobbers human KB/skill edits on re-run (idempotency). (verify)
- `seed --reset` kills admin-installed MCP servers while preserving GitHub connections
  (asymmetric wipe). (verify)
- Password literal `viberr-dev-2828` tripled; stale playwright comment; untested CLI wiring.

### rbac-auth-org.md (8 candidates — strongest)
- `ALLOWED_AUTH_PATHS` gate has ZERO test coverage despite depending on
  version-sensitive better-auth hook behavior (`app/lib/auth.server.ts:52-59,190-192`).
- `buildAuthOptions` docstring references a gen/validation script that doesn't exist.
- Better Auth shared-IP rate limiter still governs the 6 allowed splat paths.
- Redundant session-revoke in `deleteOrgUser`.
- Degraded-MCP-credential state still unsurfaced in UI.
- Wipe-regenerates-user-ids baseline convention (accepted but fragile).

### agents-operator-runtimes.md (14 candidates)
- **AO-1 (HIGH · restart-recovery no-op):** `staged_outcomes` persistence (P11-28) is
  UNREACHABLE on the boot-recovery path it was built for — `outcome_key` isn't a column
  on `agent_runs`, and `recoverUnreactedAgentRuns` passes no key, so
  `applyAgentCompletionEffects` (task-actions.server.ts:~1738) skips the staged lookup
  after a real restart and Claude verdicts fall back to the prose regex. The table only
  covers same-process map misses / HMR — NOT the restart case in its own docstring. VERIFY + fix wiring.
- **AO-2 (HIGH · concurrency):** tokenless cross-boot lease release race —
  `chainRunCompletion(inflight.id, () => releaseOperatorLease(db, leaseKey))` bypasses the
  stale-release token guard and can evict a SUCCESSOR drive's lease → double-drive of one task. VERIFY.
- **AO-3 (LOW · misleading comment):** task-actions.server.ts:1702-1704 claims a
  "supporting → verdict on" default that F10-14 removed. Delete/fix.
- **AO-4 (known/owner-ruled):** Codex delivering runs are `danger-full-access`, no denylist,
  `default_tools_approval_mode:"approve"` on every MCP — only the prompt trust boundary binds.
  (R-C ruling: prompt-only. Not a new bug; note for parity testing.)
- **AO-5 (LOW, batch):** near-open resume confinement for undeployed profiles; 3 stale runtime
  doc-comments; legacy snapshot vocabulary; ask-human-default-direct as weak selection signal;
  `directiveRequestsDelivery` regex gaps; "coordinating model" copy on specialist quota failure;
  Codex packet options lack `detail`; duplicated `OPERATOR_AUDIT_ACTOR`; partial-react replay gap
  (reply-posted-but-react-lost runs unrecoverable → possible dup on retry). Triage individually.

### data-model-store.md (5 candidates)
- **DM-1 (MED · integrity):** `validation` column projects the file's cached value while
  `validation_block_reason` is re-derived (rebuilder:410 vs :412; recompute only at 3 write
  sites) → an externally-edited task can project `validation=healthy` alongside a non-null
  block reason. Recompute both together. VERIFY.
- **DM-2 (MED · observability):** KB watcher has no error recovery / health parity
  (kb-watch.service.server.ts:106-108 logs only; dead handle stays cached and returned forever;
  invisible to `/resources/health`, which reports only the projects watcher at :38). Add health
  surface + handle recovery. (Pairs with R-D/P11-60 watcher.)
- **DM-3 (MED · phantom state):** `resetStore` never clears `scope_violations`
  (seed.server.ts:72-83) → open violations survive a clean-sheet reset and resurrect as phantom
  Settings badges when a same-slug project is recreated. (Same root as seed agent's finding.) VERIFY.
- **DM-4 (LOW):** demo fixture inserts violations via raw SQL (demo-seed.ts:240), bypassing
  `openScopeViolation`'s audit + SSE — fixture can drift from real write path.
- **DM-5 (LOW residuals):** no project.md `updatedAt`; dual user tables; legacy
  `specialist_json`/`reviewers_json`; watcher double-filter; per-process-only locks.

### delivery-github-review.md (11 candidates)
- **DG-1 (HIGH · acceptance dead-end):** `openTaskPr` cached-PR fast path (pr-open.server.ts:142)
  reuses a **merged** cached PR (`state !== "closed"` still matches `"merged"`) → after an
  out-of-band merge + rework on the same branch, no fresh PR ever opens and acceptance dead-ends
  at "merge pending". F26 protects only the `findPrForBranch` path, not this one. VERIFY LIVE (gh merge then rework).
- **DG-2 (MED · un-acceptable task):** the `force` acceptance override has ZERO callers on
  current main (pass-11's claim the task route sets it is stale) → a task with an un-recordable
  required reviewer is permanently un-acceptable. VERIFY + wire or remove.
- **DG-3 (MED · poller):** reconcile poller writes per-task audit + provenance rows every 5 min
  (`skipProjectAudit` only gates the project summary; provenance has NO retention → unbounded
  growth), and a rate-limit 403 on the compare is indistinguishable from a scope 403 → the poller
  can auto-open BOGUS `repo` scope violations. Parsed `rateLimit` has zero consumers. VERIFY.
- **DG-4 (LOW):** `up_to_date` push result variant declared + checked but never constructed (dead).
- **DG-5 (LOW):** PR-open `auth_failed`/`network_unavailable` at Review is still only a log line
  (push failures got surfaced in P11, PR-open ones didn't) — silent failure at the review boundary.
- **DG-6 (LOW batch):** stale "migration 0005" comment; pre-poller comments in github-query; dead
  `prPillFor` duplicate; poller blind spot for task-level `repo:` overrides; silent boot-pass errors.

### routes-ui-map.md (16 candidates)
- **RU-1 (MED · UX correctness):** Profile overlay fires theme/motion/timeline toasts on
  every submit even when nothing changed (P11-40 gap: routes/profile.tsx:164,
  profile-page.tsx:303-319). Should only toast on an actual change.
- **RU-2 (MED · misleading create UI):** create-profile modal offers backends that aren't
  configured/available (P11-41 gap: create-profile-modal.tsx:216-227) → a user can create an
  agent pinned to an unavailable backend. Gate the picker to available backends.
- **RU-3 (LOW):** last hardcoded role-literal gate at settings-page.tsx:736-737 (should route
  through `roleCan`/ACTION_ROLES like the others that P11 converted).
- **RU-4 (LOW):** notifications list caps at 100/200 with nothing paging past 200 — silent
  truncation for a busy instance.
- **RU-5 (LOW batch):** remaining route residuals from the map's candidate list — triage
  against the doc when implementing.
- (24 routes enumerated 1:1 with app/routes.ts; no product route references demo data — clean.)
