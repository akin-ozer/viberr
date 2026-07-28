# S4-github — adversarial verification

Branch `pass15/product-fixes`, working tree (every S4 source file is uncommitted).
Method: read the diff; for each claim, restore the OWNED source file(s) to `HEAD`
(tests untouched) and re-run the named tests; restore; re-run green. Gates run
repo-wide.

## Gates

- `npm run typecheck` — 5 errors, **all** in `app/server/tasks/capability-denylist-markers.test.ts`
  (not an S4 file, `mode: string` vs the literal union). Zero errors in any S4 file.
- `npx vitest run <S4 test files>` — **7 files / 136 tests passed**.
- Merge-path siblings (`task-actions`, `acceptance-graph`, `acceptance-closed-pr`,
  `operator-actions`, `agent-completion`, `delivery-decision`, `task-detail-route`) —
  199 passed: the new post-merge cleanup does not disturb other merge callers' timelines.
- Full suite `npx vitest run` — **205 files / 2367 tests passed**.

## Per-claim verdicts

| id | verdict | evidence |
|----|---------|----------|
| F15-01(b) card | **CONFIRMED** | `credential-card.tsx:86` `const unverified = proven.length === 0`. With `HEAD`'s card the named test fails: `github-view.test.tsx > "all-assumed scopes are the unverified state, never the green line"` → `AssertionError: expected <div class="cred-ok">…</div> to be null`. The companion green-line test passes on both — a regression guard, not a proof. |
| F15-01(a) probe-at-creation | **UNPROVEN (correctly handed back)** | `app/features/home/project-create.server.ts` is untouched (`git status`). `proveAttachedCredential` exists and is exported (`github-actions.server.ts:126`), but its only caller today is `runSetCredential:198`, so it is behaviour-neutral. Handback patch reviewed and applies cleanly to `project-create.server.ts:308`. |
| B-GH2 | **CONFIRMED** | `connections.server.ts:284-291` interpolates `CONNECTION_REQUIRED_SCOPES.join(" · ")`. On `HEAD`: `connections.server.test.ts > "names the live minimum…"` fails (`expected '…' to contain 'Minimum scopes: repo · pull_request:w…'`). |
| B-GH6 | **CONFIRMED (refactor, not a behaviour fix)** | `connections.server.ts:54` `export const CONNECTION_REQUIRED_SCOPES = DEFAULT_REQUIRED_SCOPES` (`pat-store.server.ts:36`). The two tuples were already value-identical, so the proving test is an identity assertion (`toBe`) — it fails on `HEAD` only because the objects differ, not because any user-visible behaviour did. Correct and worth having; sev L as filed. |
| B-GH3 | **CONFIRMED — with a new false-refusal path (see gap 1)** | `github-actions.server.ts:161-190`: repo owner → `getConnection(db, slugify(owner))`; connection ids ARE `slugify(owner)` (`connections.server.ts:383`), so the lookup is sound. Both named tests fail on `HEAD` (`expected 'pat_i5OJ…' to be 'pat_HU_k…'`, `expected 'attached' to be 'no_owner_connection'`). |
| B-GH7 | **CONFIRMED as landed; the claim's own scope is narrow** | `ensureConnectionFresh` (`connections.server.ts:206-256`) — 24 h window, single `repo: null` probe, `network_error` explicitly not a downgrade, audit row on demotion. All three tests fail on `HEAD` (two as `TypeError: … is not a function` — existence proofs, weaker than behaviour proofs). Wired into exactly ONE use site (`runSetCredential`); `getDefaultConnectionToken` (sync) and every delivery path still trust the cached verdict forever. The ledger says this; keep the row honest as "partial". |
| B-GH8 | **UNPROVEN (correctly handed back)** | `app/server/secrets/pat-validator.server.ts` untouched. Handback carries the exact patch site + a proving-test recipe. |
| B-GH5 | **CONFIRMED** | `github-reconciler.server.ts:546-566` (`RECONCILE_TASK_CONCURRENCY = 4`, `RECONCILE_POLL_TASK_BUDGET = 20`, module-level `reconcileCursors`), worker pool at `:614-634`, poller at `reconcile-poller.server.ts:118`. All three tests fail on `HEAD` (`peak` undefined, `expected [10 items] to have length 4`, `expected undefined to be 0`). Cursor rotation verified by hand: wrap is correct, `rotated[budget]` always defined when `allKeys.length > budget`, and the second pass shares no key with the first. |
| R15-6 | **CONFIRMED** | Storage `branch-cleanup.server.ts:34-56` (absence = ON), writer `settings-actions.server.ts:167-206` (`edit-policy` = admin, matching the UI's `canRepair={isAdmin}` — `rbac.ts:64`), hook `github-reconciler.server.ts:869-895`, UI `settings-page.tsx:759-785`. On `HEAD`: all 3 reconciler cases, all 4 `setBranchCleanup` cases and both `settings-page` cases fail. **Caveat:** `"respects the project's opt-out — the branch stays"` cannot fail on `HEAD` (old code never deleted anything) — it is a guard, not a proof; the proof is the default-ON case. Ordering claim verified: `pr.state` is patched to `merged` before cleanup runs, so `deleteTaskRemoteBranch`'s open-PR refusal (`:1012-1018`) correctly stands down. |
| F15-03 | **CONFIRMED benign** | `file-watch.service.server.ts:203-209` schedules `rebuildDir` on every `rename`; the removal sweep (`:152-167`) is `rebuildPath` + a per-task `rebuildTaskFile`, i.e. an idempotent upsert that removes a row only when the file is absent. No state-loss path. Cost is a false log line + one wasted reproject per project creation, as filed. |

## Ruling compliance (FINDINGS §D)

- **R15-6** ("per-project setting, default on") — satisfied. The deviation is
  the storage shape (guardrail row instead of a first-class frontmatter key);
  FINDINGS:106 states it, the reader/writer are one function each, and absence =
  ON means no project.md rewrite. Confirmed that `guardrails` reaches no agent
  prompt and no other UI (`grep`: only `comment-guardrails.server.ts` reads it,
  by id), so the extra row cannot leak into an agent's instructions or a
  guardrail list.
- No fix in this stream overrides an explicit admin decision: the opt-out is
  honoured before any DELETE, and `deleteTaskRemoteBranch`'s structural refusals
  (default branch, open PR) are unchanged.
- No dropped events: the merge's own `github` event, provenance, audit and
  violation resolution all still run before cleanup; cleanup only ADDS (a
  `github` "Deleted branch" event on success, a policy-engine `note` on every
  non-success). The one rewritten assertion in
  `"merges, flips the cache, writes the github event, resolves the task's
  pull_request:write violation"` now covers all three events — it was widened,
  not weakened.
- One **unclaimed** change sits in an owned file: `addStage` name-first
  (`settings-actions.server.ts:408-419`, `settings-page.tsx:136-206`,
  `project.settings.tsx:83-88`) with 2 + 4 tests. It is green and fails on
  `HEAD`, but it is not in S4's ledger — the lead should attribute it (UX stream?)
  before the ledger audit.

## Three most dangerous gaps

### 1. B-GH3 turns a legitimately working setup into a permanent refusal

`runSetCredential` now hard-refuses whenever no connection id equals the repo
owner (`github-actions.server.ts:163-175`) — no access probe, no fallback to the
default connection. But **connection.owner is a label, not an access boundary**:
one PAT routinely reaches repos under other owners (org repos, collaborator
repos), and `repairProjectRepo` deliberately accepts any `owner/name` —
its documented contract is "nothing is inferred from the connection owner and
there is no automatic failover" (`settings-actions.server.ts:249-256`), and it
validates the new repo with the **bound** credential, not with an owner-matched
one. So a project repaired to `someorg/app` while the org's single connection is
`akin-ozer` can no longer be attached or rotated at all, and the toast tells the
admin to add a PAT for an owner they may have no token for. The second B-GH3
test pins this refusal as intended, so it will not be caught later.
Suggested shape: prefer the owner-matching connection, else fall back to the
default and *probe* `GET /repos/{repo}` — refuse only on a real access miss.

### 2. R15-6 + B-GH5 interact: deleted branches become zombie reconcile work

Cleanup deletes the remote ref but leaves `frontmatter.branch` set, and
`reconcileProject` selects on `branch IS NOT NULL` only
(`github-reconciler.server.ts:591-595`) — merged tasks are never excluded. Every
merged task therefore keeps costing a guaranteed 404 `compare` call each pass
(`missing_ref`, `branch-sync.server.ts:99`), forever. Under the new
`RECONCILE_POLL_TASK_BUDGET = 20` rotation those zombies consume the budget: a
board with 100 merged + 5 active tasks now syncs its live PRs roughly every
5th tick (~25 min) instead of every tick. (No state is lost — `compare === null`
keeps the cached commits — it is purely quota + freshness.) Fix candidates:
exclude terminal/merged tasks from the reconcile query, or clear `branch` when
the cleanup succeeds.
Same block, smaller: the cleanup is *not* wrapped in `try/catch`. Its contract
says it can never demote a merge, but `branchCleanupOnMerge`'s DB read,
`appendTimelineEvent` and `rebuildPath` can all throw *after* GitHub has already
merged, and the caller would surface that as a failed acceptance.

### 3. `ensureConnectionFresh` clobbers the SHARED per-PAT validation cache

`recordPatValidation` overwrites `github_pats.validation_json` wholesale
(`pat-store.server.ts:207-217`), and project scope chips are rendered straight
off that row (`pat-store.server.ts:380-397`). `ensureConnectionFresh` probes with
`repo: null` (`connections.server.ts:233`), which for a fine-grained token yields
all-`assumed` scopes. So attaching/rotating project B's credential downgrades
**every other project bound to the same connection PAT** to zero proven scopes —
and thanks to F15-01(b) those cards now flip from the green line to the
"scopes not yet verified" warning. Today the blast radius is bounded (only
`runSetCredential`, and it re-proves for its own project immediately after), but
the B-GH7 handback proposes wiring `getDefaultConnectionTokenFresh` into the
store-file import path, which would fire this on a routine import. Before that
lands, `ensureConnectionFresh` should either merge into the cached scopes rather
than replacing them, or record its verdict on the connection row only.

### Worth flagging alongside

F15-01(a) is handed back, so **every newly created project still ships with zero
proven scopes** — and F15-01(b) now renders that as a warning banner where it
previously (wrongly) rendered green. The pair should land together, or pass 15
ships a louder warning on every fresh project than the one it replaced.

### Smaller notes

- `reconcileCursors` is module-global and keyed by slug; it is never pruned
  (bounded, harmless) but it does leak across tests in the same file — only one
  budgeted test exists today, a second would inherit a stale cursor.
- `runSetCredential`'s `no_owner_connection` / `connection_invalid` results are
  new `result` strings; nothing switches on them (`grep`), so no UI is stranded.
- The GitHub view still offers "Attach credential" for a project whose repo owner
  has no connection; the server answers with an honest degraded toast rather than
  an error, but the button can never succeed until gap 1 is addressed.
