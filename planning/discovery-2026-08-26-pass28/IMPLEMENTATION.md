# Pass 28 — implementation record (2026-08-26)

Baseline: origin/main `97ef4c4` (pass 27). Branch `fix/pass28-findings` → **PR #230** (open, mergeable).
Container ran pass-27 main throughout discovery; fixes validated via full suite + hermetic :5174 (worktree code).

## Gates (all green)
- **Full suite: 288 files · 4469 tests pass** (+5 net; the pre-existing `notifications-route` SSE-teardown
  flake is order-dependent and unrelated — 0 overlap with changed files, passes on retry).
- **tsc: clean.** **oxlint: 25 baseline (0 new anti-slop).**
- **Browser-validated (hermetic :5174, my worktree code, real 3-project/12-task demo data root):** boots clean,
  projection rescan error-free, home/board/task-detail/activity/404 all render. Discovery live-confirmed the
  pre-fix behaviors and the pass-27 fixes (F27-U1 %, F27-U2, F27-P3, F15-13/15).

## Shipped fixes (12 findings, each with a test; the subtle ones canaried)

| ID | Sev | Fix | Commit |
|----|-----|-----|--------|
| **F28-P1** | HIGH | `@agent` mention RESUME (`resolveMentionedAgent`, both branches) now resolves `pinnedBackend ?? live ?? snapshot` | 90c383c |
| **F28-P2** | LOW | agents-page chip + execution-profile "model unavailable" now pin-aware | 90c383c |
| **F28-U2a** | MED-HIGH | `mergeTaskPr` now proves `pull_request:write` too (not just PR-open) | 90c383c |
| **F28-U2b** | MED | `markWriteScopeProven(patId)` — proves the credential that MADE the call, not whatever is bound now | 90c383c |
| **F28-D2** | HIGH | `splitFrontmatter` normalizes CRLF/CR→LF (was LF-only fence check → whole file lost) | 2277dbd |
| **F28-D3** | HIGH | `content_hash` written LAST (commit marker via sentinel + final UPDATE); removed paths drop probe-target row last | 2277dbd |
| **F28-D1** | MED-HIGH | activity stream tie-breaks on `id ASC` (task_events position-0 = smallest id) | 2277dbd |
| **F28-O1** | MED | Codex-operator plan ABORT narrated DIRECTLY (gate-bypassing), like narrateRefusedActions | 88b08dc |
| **F28-R1** | MED | `interruptRun` frees a still-RESERVED run's concurrency slot + drains immediately | 60b0214 |
| **F28-A1** | HIGH (owner-Q) | dropped github/google from `accountLinking.trustedProviders` (no-verify implicit-link takeover) | 6ade123 |
| **F28-U1** | LOW/UX | clone `%` leads (survives run-strip ellipsis truncation) | 36c6ba7 |
| **F28-L1** | MED-HIGH | R20-2 no-change AUTO-DETECT permit path made live: all 3 accept paths run the probe before the gate + thread a verified-empty flag (excl. `no_repo` basis) through every gate call | 880c62c, 954686f |

## Themes
- **Pass-27 features under-threaded** (P1/P2 pinnedBackend, U2a/b markWriteScopeProven): a new field/flag added to
  one consumer, missed at the others.
- **Event-sourcing robustness** (D1/D2/D3): CRLF, torn-write crash-consistency, same-timestamp ordering.
- **Dead permit path** (L1): R20-2 auto-detect existed with a dedicated field + write branches, but the sync gate
  threw before the async probe ran — the whole mechanism was unreachable.

## Owner decision — F28-A1 → KEEP (ruled 2026-08-26)
- **F28-A1** — a real, CVE-aligned account-takeover hole once OAuth is enabled (off by default). Fixed with a
  1-line `trustedProviders` change that preserves the intended whitelist auto-link for a provider-VERIFIED email.
  Flagged for the owner given the "side project, skip security deep-dives" stance. **The owner reviewed the full
  mechanism and chose to KEEP the fix** (verified-email auto-link + admin-whitelist provisioning unaffected; the
  change is inert while OAuth is off and closes the hole the moment it's enabled). No longer a pending question.

## Test-hygiene note (for continuity)
An oxlint base-comparison ran `git checkout HEAD -- app`, which discarded a still-UNCOMMITTED F28-L1 refinement
(the `no_repo` exclusion); the next commit captured the reverted version. Caught by the full suite, re-applied in
954686f. Lesson: commit a fix BEFORE any `git checkout -- .` comparison, or the checkout eats uncommitted work.
