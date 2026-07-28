# G-C-github — adversarial verification of the gap repairs

Branch `pass15/product-fixes`, dirty tree. Method: for every claim, restore the
**source** file(s) to the pre-repair shape (tests untouched), run the named
tests, record the literal failure, restore byte-for-byte (`shasum -a 256 -c`
verified after every experiment, and a final green re-run). Judged files:

- `/Users/akinozer/projects/viberr/app/features/github/github-actions.server.ts`
- `/Users/akinozer/projects/viberr/app/features/github/github-actions.server.test.ts`
- `/Users/akinozer/projects/viberr/app/server/github/github-reconciler.server.ts`
- `/Users/akinozer/projects/viberr/app/server/github/github-reconciler.server.test.ts`

Sibling-owned files were read but never judged.

## Verdicts

| claim | canary | repair |
|---|---|---|
| **S4-1** owner-match is a preference + probe | **CONFIRMED** | **CONFIRMED, with two defects** (§1, §3) |
| **S4-2** zombie reconcile work | **CONFIRMED** | **BROKEN — drops a documented event** (§2) |
| **S4-2b** cleanup try/catch | **CONFIRMED** | **CONFIRMED, signal silenced** (§4) |
| **lesser** `resetReconcileCursorsForTests` | n/a | **UNPROVEN — the stated justification is false** (§5) |
| **lesser** new `result` strings strand no UI | n/a | **CONFIRMED** |
| **lesser** "Attach can never succeed for an unowned owner" | n/a | **PARTIAL** — only via the *default* connection (§3) |
| **gap 3** `ensureConnectionFresh` cache clobber = NOT MINE | n/a | **CONFIRMED** — `connections.server.ts` / `pat-store.server.ts` are clean in `git status` |

### Canary transcripts (exact)

**S4-1, B-GH3 shape restored** (`connection = repoOwner ? owned : default`, probe + borrow-toast disabled), `npx vitest run app/features/github/github-actions.server.test.ts`:

```
× borrows another owner's connection when GitHub says that token reaches the repo
× refuses — naming the probe result — when the fallback token cannot reach the repo
AssertionError: expected 'no_owner_connection' to be 'attached' // Object.is equality
AssertionError: expected 'no_owner_connection' to be 'no_repo_access' // Object.is equality
Tests  2 failed | 4 passed (6)
```

**S4-1, probe alone disabled** (fallback kept ≈ `main`):

```
× refuses — naming the probe result — when the fallback token cannot reach the repo
AssertionError: expected 'attached' to be 'no_repo_access' // Object.is equality
Tests  1 failed | 5 passed (6)
```

Note: the *borrow* test still passes with the probe disabled, so it proves the
fallback, not the probe. The refusal test is the only probe proof. Both match
the ledger.

**S4-2, filter line removed** (`const allKeys = rows.map(r => r.task_key)`):

```
× a budgeted pass spends the whole budget on live tasks, not on merged-and-cleaned ones
AssertionError: expected [ 'VIB-301', 'VIB-800', …(2) ] to deeply equal [ 'VIB-301', 'VIB-900', 'VIB-901' ]
Tests  1 failed | 35 passed (36)
```

Ledger says "1 failed / 34 passed" — the file has 36 tests, so the passing count
is off by one. Cosmetic. The second named test,
`"a manual Update status still re-checks a merged task"`, **passes on the
pre-repair code too** — it is a guard, not a proving test, and the ledger lists
it as one.

**S4-2b, `try {` → bare block, `} catch { }` removed:**

```
× a THROWING cleanup never demotes the merge either
Error: projection read failed
     42|       if (cleanupFault.throws) throw new Error("projection read failed…
Tests  1 failed | 35 passed (36)
```

The fault injector throws from the *first* statement in the `try`, so it proves
the guard exists; the `appendTimelineEvent` / `rebuildPath` throws named in the
comment are covered structurally (same block), not by assertion.

### Gates

- `npm run typecheck` — **clean, repo-wide** (0 errors). The 5
  `capability-denylist-markers` errors the previous verifier saw are gone.
  Ledger claim confirmed.
- `npx vitest run app/features/github app/server/github` — **15 files / 205
  tests passed**, both before and after every experiment (byte-for-byte restore
  verified).
- `npx vitest run` (full) — **205 files passed / 1 failed; 2409 passed / 1
  failed**. The single failure is
  `app/features/agents/agents-route.server.test.ts > AP-05 … > deploy-profile
  reports a contradictory template's delivery withholding (B-AG1 shape)` —
  a sibling stream's file, not this stream's. The ledger's 5 failures (incl. the
  `settings-route.server.test.ts` "hand-off needed") **no longer reproduce**;
  siblings have since fixed them. The hand-off row can be dropped.

### Ruling compliance (FINDINGS §D)

- **R15-6** (per-project branch cleanup, default on) — untouched in substance;
  the try/catch only widens the "cleanup can never demote a merge" contract the
  ruling's implementation already claimed. Guardrail read, refusal notes and
  ordering are byte-identical.
- **R15-2** (delivery/coordination is an OPERATOR decision) — **degraded by
  S4-2**, see §2: the poller can no longer wake the operator on a reopened PR.
- R15-1/3/4/5/7/8 do not reach these files. No fix here overrides an explicit
  human decision: the cleanup opt-out is still honoured, and the new refusal
  path never binds anything (`getProjectCredential` stays `null`, asserted).

---

## Three most dangerous remaining gaps

### 1. (§2) The terminal filter kills the poller's PR-reopen detection — a dropped event

`github-reconciler.server.ts:602` marks a row terminal when
`archived = 1 OR pr_json.state IN ('merged','closed')`, and `:620` drops those
rows whenever a budget is in force. **The poller is the only caller that sets a
budget** (`reconcile-poller.server.ts:120`, `taskBudget:
RECONCILE_POLL_TASK_BUDGET`). But a *closed* PR is not terminal — GitHub allows
reopening, and this codebase deliberately handles it:

```
github-reconciler.server.ts:330
  const prJustReopened = fm.pr?.state === "closed" && newPr?.state === "review";
```

`:331` writes the "PR live again" timeline note, `:427-451` sends the
`notifyTaskWatchers` alert `"PR #n live again on GitHub — VIB-x resumes"`, and
`:456-470` fires `autoInvokeOperator(..., "pr-diverged")` **specifically to
withdraw the now-moot recovery packet**. All three are now unreachable from the
only automatic path. Proven directly (temporary probe test, since removed):

```
BUDGETED (taskBudget: 20) visited: []   skipped: 0
MANUAL   (no budget)      visited: ["VIB-777"]
```

…for a single task with `pr: { state: "closed" }` whose PR GitHub reports as
open. So after a human closes a PR on GitHub and then reopens it (the
documented rework loop that `closedButActive` + the recovery packet exist to
serve), the board stays stale and the stranded packet stays open **forever**,
until someone happens to press "Update status". The proving test only exercises
`merged` rows, so nothing catches this.

Also note `skipped: 0` — terminal drops are not counted in
`ProjectReconcileSummary.skipped` (whose own doc comment at `:530-531` says
"deliberately deferred to the next tick"; these are deferred forever). Only the
audit `details.terminal` (`:685`) records them, and nothing outside tests reads
`skipped`.

**Minimal fix:** drop `'closed'` from the terminal predicate at `:602-604` —
`merged` and `archived` are genuinely terminal, `closed` is not. If closed rows
must be cheapened, they need a separate low-frequency lane, not exclusion.

### 2. (§1) The probe hard-refuses on *every* 403, against this codebase's own DG-3 rule

`github-actions.server.ts:189-194` maps any 403 to `access_miss`, which is a
hard refusal (`:267-273`, `result: "no_repo_access"`, nothing bound). Every other
403 consumer in the repo discriminates rate-limit 403 from permission 403,
explicitly because GitHub uses one status for both:

```
branch-sync.server.ts:106-113
  // Rate-limit 403 vs scope 403 (DG-3): GitHub zeroes x-ratelimit-remaining on
  // a primary limit, and secondary limits carry a "rate limit" message.
  const isRateLimited = result.rateLimit.remaining === 0 || /rate limit/i.test(result.message);
```

`repo-access-check.server.ts:67-75` additionally splits `org_approval_missing`
out of 403. The new probe does neither. So an admin who hits a secondary rate
limit — likely, since the poller now runs 4-wide against one PAT — is told
`"hepapi's token cannot reach akin-ozer/viberr — GitHub refused it with 403 (…).
Add a PAT for akin-ozer in org settings"`, and the attach/rotate is refused. That
is precisely the "transient blip reported as a permissions failure" that DG-3
was filed to stop, reintroduced in a new place. `rateLimit` is already on the
result object (`github-client.server.ts:53`), so the fix is two lines: route
rate-limited 403 to `unverified`, not `access_miss`.

Secondary: the probe duplicates `checkRepoAccess`
(`repo-access-check.server.ts:36-78`) — same `GET /repos/{repo}`, richer
classification — with a worse local mapper. Reusing it (with an explicit
patId/token override) would have inherited the 403 split and the
`org_approval_missing` case for free.

### 3. (§3) The fallback tries only the DEFAULT connection, so multi-connection orgs are still permanently refused

`github-actions.server.ts:230-233`:

```ts
const owned = repoOwner ? getConnection(db, slugify(repoOwner)) : null;
const connection = owned ?? getDefaultConnection(db);
```

`getDefaultConnection` is `WHERE is_default = 1` (`connections.server.ts:159-166`)
— exactly one row. Take an org with two connections, `hepapi` (default, no
access) and `akin-ozer` (a collaborator that *can* see `someorg/app`), and a
project repaired to `someorg/app`. `owned` is null, the default is probed, GitHub
404s, and the bind is refused — the same permanent refusal the repair was filed
to remove, just one connection narrower than before. The toast then compounds it:
`"Add a PAT for someorg in org settings, or fix the repository here"` names an
owner for whom a PAT may not exist and may not be needed, while the connection
that *would* work sits unlisted. Since the probe machinery now exists, the honest
shape is: prefer owner-match, else probe each connection (or at least name the
ones tried) before refusing.

---

## Smaller notes

- **Silent `catch {}`** (`github-reconciler.server.ts:931-933`). Every *returned*
  cleanup failure lands as a plain-words timeline note; a *thrown* one now lands
  as nothing at all — no note, no audit, no log. The merge is correctly not
  demoted, but the branch silently survives with zero record. A `logger.warn`
  plus (best-effort) the same note would keep the contract and the signal.
- `resetReconcileCursorsForTests` (`:568`) is **not load-bearing**: removing the
  `beforeEach` leaves all 36 tests green. The new budgeted test has 3 keys after
  filtering against a budget of 4, so it takes the `else if (budget > 0)` branch
  that *deletes* the cursor — it never reaches the rotation at all. The ledger's
  "it is what makes the two new budgeted tests independent" is false as written.
  Keeping the export is fine as hygiene; the justification should be corrected.
- A board that is 100 % terminal under a budgeted pass now returns
  `results: []` while `rows.length !== 0`, so the F15-02 heartbeat at `:697-706`
  is skipped and no per-task provenance is written either — such a project can
  read "not yet synced" indefinitely on the poller alone.
- The borrow path costs **two** `GET /repos/{repo}` calls (the probe, then
  `proveAttachedCredential` → `revalidateProjectCredential`). Unavoidable given
  the probe must precede the bind, but worth knowing on a rate-limited PAT.
- `no_owner_connection` is gone, so a repo'd project with zero connections is
  back to `main`'s generic `"No GitHub connection to attach"` toast — the
  owner-naming guidance added in wave 2 is lost. Disclosed as deviation 2; no UI
  switches on the string (`grep` over `app/`: `no_repo_access` at
  `github-actions.server.ts:271` and `connection_invalid` at `:253` are
  toast-only).
- Degenerate input: a malformed `repo` like `"/name"` yields `repoOwner === ""`
  (`?? null` does not catch the empty string, `:229`), producing a `"no  PAT"`
  toast. Cosmetic, and unreachable if `repairProjectRepo`'s validation holds.
