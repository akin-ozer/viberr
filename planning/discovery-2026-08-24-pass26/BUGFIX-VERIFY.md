# Bugfix verification — pass 26 (2026-08-24)

Verifying four fixes by tracing the actual enforcement/render path on HEAD, not by trusting the
commit message or code comments. Test files touched by these fixes were re-run directly (not
"suite green" taken on faith): `task-actions.server.test.ts`, `policy-rbac.server.test.ts`,
`rate-limit.server.test.ts`, `login.server.test.ts`, `agents-page.test.tsx`, `task.server.test.ts`
— **274/274 passing** on HEAD.

Verdicts: **SOLID** (fully closes the hole, no bypass found) / **RESIDUAL-GAP** (a real bypass or
incoherence remains) / **REGRESSION** (the fix broke something else).

---

## 1. `f8333af` — contributor seizing an occupied owner seat — **SOLID**, with an important correction

### What the bug was
`setOwner` (`app/server/tasks/task-actions.server.ts:3663`) gated **hand-off** (giving the seat to
someone else) behind `release-any-ownership`, but a self-**take** (`isTake = targetUserId ===
actor.userId`) of an already-occupied seat slipped past that guard entirely — any `own-task` holder
(contributor+) could seize a task another member owned. Ownership carries the **owner-exception**:
`ownerException()` (`task-actions.server.ts:300-311`) grants `requireAcceptCompletion` /
`requireDecisionAuthority` to whoever is `ownerUserId`, *regardless of role*, as long as they still
hold `own-task`. So a plain contributor who seized a seat instantly gained accept-completion +
resolve-packet authority (and, via `manualDeliverForReview`'s owner-exception at
`task-actions.server.ts:4888-4914`, PR-delivery authority too) that their role does not otherwise
grant — a real escalation.

### ⚠️ The shipped rule is NOT what `f8333af`'s commit message says — a same-day follow-up changed it
`f8333af` gated the takeover on `release-any-ownership` (admin-only), exactly as its commit message
states. But commit `d16f4b5` ("Fix full-suite regressions…"), three hours later on the same branch,
**replaced that gate** with `accept-completion` (admin **or maintainer**):

```
app/server/tasks/task-actions.server.ts:3693-3702  (current HEAD)
  if (
    isTake &&
    currentOwnerId &&
    currentOwnerId !== actor.userId &&
    !roleCan(actorRole, "accept-completion")     // was "release-any-ownership" in f8333af
  ) {
    throw AppError.forbidden(
      "This task already has an owner. Taking it over needs completion-acceptance authority ..."
    );
  }
```

Rationale (from `d16f4b5`, and independently verified below): a maintainer already holds
`accept-completion` project-wide, so a maintainer taking over a task grants them nothing they didn't
already have — the escalation is contributor-only. **If you evaluate `f8333af` in isolation you get
the wrong answer for what ships.** The takeover rule on HEAD is: **acceptance-authority
(admin/maintainer), not admin-only.**

### Why the gate is well-targeted, not just "broad enough"
`ownerException`'s two direct call sites (`requireAcceptCompletion` line 314-323,
`requireDecisionAuthority` line 338-347) both fall back to `roleCan(role, "accept-completion")` /
`"resolve-packet"` when the actor isn't the owner. In `app/shared/rbac.ts:71-75`,
`resolve-packet`, `accept-completion`, and `run-agents` are **all** `[admin, maintainer]` —
identical role sets. So gating the takeover on `accept-completion` transitively closes every
owner-exception surface that exists today (resolve-packet at
`task-actions.server.ts:5587-5608`, the coordination-execution exception in
`applyRecommendation` at `:7908-7927`, and the delivery exception in `manualDeliverForReview` at
`:4888-4914`) — not just the one named in the commit message. This is a single choke point at
seat-acquisition rather than three separate patches, which is the right shape.
**Caveat (low severity, maintainability only):** this correctness depends on `resolve-packet` /
`run-agents` staying in lockstep with `accept-completion`'s role list — nothing enforces that
coupling, so a future RBAC change to just one of them would silently reopen a gap the guard no
longer matches. No live bug today.

### Bypass search — confirmed none for a contributor
- Only 3 writers of `ownerUserId` exist in the whole app: `setOwner`, `releaseOwner`, and
  `releaseTasksOwnedBy` (system-triggered on member removal, target is never attacker-chosen) — all
  in `task-actions.server.ts`. `grep -rn "ownerUserId\s*="` confirms no other file/route ever writes
  it.
- Only 2 call sites invoke `setOwner`: `app/routes/project.task.tsx:706-717` (`owner-take`,
  `targetUserId` **hardcoded to `ctx.user.id`** server-side — a form POST cannot change it) and
  `:718-730` (`owner-assign`, `targetUserId = formData.get("userId")` — fully attacker-controlled).
  Critically, `owner-assign` with `userId` set to **your own id** is also `isTake = true` and hits
  the identical guard — so there is no route/intent combination that reaches the mutation without
  passing through the new check.
- UI reachability is narrower than the API: `task-side-panels.tsx:804`
  (`(ownerMine && canOwn) || canReleaseAnyOwner`) only shows the reassign/release dialog
  (`release-confirm.tsx:145-167`, the sole UI path that can fire `take`/`assign` on someone else's
  seat) to the current owner or an **admin** — a maintainer has no UI affordance for their new
  API-level takeover right at all. Not a security issue (nothing is exposed that shouldn't be), just
  means the relaxation `d16f4b5` shipped is presently API-only for maintainers too.
- Confirmed live: `task-actions.server.test.ts` "ownership" describe block — contributor takeover
  attempt → 403; maintainer takeover of an admin-owned task → succeeds. Ran green.

### Worth the owner's attention (not a security hole, a policy note)
Because the gate is `accept-completion` (not `release-any-ownership`), a **maintainer can now
unilaterally evict an admin from a task the admin owns**, with no admin consent, via a plain
`owner-take`/`owner-assign(self)` POST — whereas `releaseOwner` still requires
`release-any-ownership` (admin-only, `task-actions.server.ts:3803-3806`) for a maintainer to merely
*release* (not take) someone else's seat. So a maintainer can achieve "evict + become owner" in one
step at a lower bar than "evict" alone requires through the sibling function. This is the direct,
intended consequence of `d16f4b5`'s reasoning (maintainers already hold the power ownership would
grant) and is test-covered, not an oversight — but it is a real behavior change from "no one but an
admin displaces another member" worth the owner explicitly signing off on.

---

## 2. `cdac955` — login throttle bypass via spoofed X-Forwarded-For — **SOLID**

### What the bug was / what the fix does
`clientIpOf` used to trust the **leftmost** `X-Forwarded-For` hop unconditionally — 100%
client-controlled in the shipped proxy-less deployment, so a brute-forcer rotated it per attempt to
get a fresh `email|ip` bucket every time. The fix (`app/server/auth/rate-limit.server.ts:149-191`)
only reads XFF when `VIBERR_TRUST_PROXY=N` (default 0) is set, and then takes the **Nth hop from the
right** — `chain[chain.length - hops]` — the address the outermost *trusted* proxy actually observed,
past any client-prepended spoof prefix. Below `N` hops (misconfig/stripped) or `N=0` → `"local"`
(one shared bucket per email, safe because the key also carries the email).

### Verified: no bypass via a different header, a different endpoint, or rotation
- `grep -rn "X-Forwarded-For|X-Real-IP|forwarded-for|remoteAddress"` across `app/` turns up exactly
  one reader of any IP-ish header in the whole codebase: `clientIpOf` itself. There is no
  `X-Real-IP`/`Forwarded`/`True-Client-IP` fallback anywhere to spoof instead.
- Two entry points reach the login limiter — the app's own action
  (`app/server/auth/login.server.ts:74`, `clientIpOf(deps.requestHeaders)`) and the raw
  `/api/auth/sign-in/email` splat via better-auth's `before` hook
  (`app/lib/auth.server.ts:250-273`, `clientIpOf(ctx.headers)`) — **both** call the same fixed
  function, so hitting better-auth directly doesn't dodge the fix.
  `/sign-in/social`'s limiter (`auth.server.ts:279-286`) reuses the same `ip` value too.
- The math is correct against a client trying to push its real IP further left: a trusted proxy
  chain only ever **appends**, so the client can prepend arbitrarily many fake hops and the
  rightmost `N` entries — the only ones read — are still exactly what the trusted infrastructure
  appended. Verified against the 1-hop and 2-hop test cases in `rate-limit.server.test.ts`.
- `getPatValidationRateLimiter` is keyed on the authenticated user id
  (`rate-limit.server.ts:98-111`), not IP — no XFF angle applies there.
- `VIBERR_TRUST_PROXY` is read as raw `process.env` at call time
  (`trustedProxyHops()`, `rate-limit.server.ts:152-157`) rather than through the cached `getEnv()`
  singleton — this matches the codebase's own established convention for optional runtime knobs
  (`env.server.ts:139-150`, same pattern as `VIBERR_CLAUDE_MAX_TURNS` etc.), not a deviation, and
  `loadEnvFile()` runs at `env.server.ts` module-load (`env.server.ts:1-12`) well before any request
  is served.
- Residual trust assumption (inherent to any XFF/trust-proxy design, not a code defect): correctness
  when `VIBERR_TRUST_PROXY>0` still depends on the operator setting `N` to match real topology and
  the network actually preventing direct, proxy-bypassing access to the origin. Standard operational
  caveat, documented in the code and `.env.example`.

---

## 3. `1cd86c8` — agents hero "running on N tasks" for idle engagements — **RESIDUAL-GAP**

### What the bug was / what the fix does
`ProfileDetail`'s hero counted every distinct engaged task key (`activeKeys`) and labelled it
"running on N tasks," so a profile merely *assigned* to tasks (no live process executing) read as
actively running. The fix (`app/features/agents/agents-page.tsx:647-654`) adds `runningKeys`,
filtered on `d.running`, and only that count gets the "running" label (`:756-758`); a nonzero
`activeKeys` with zero `runningKeys` now reads "idle · engaged on N tasks" (`:767-769`).

### The predicate itself is correct for every real `agent_runs.state`
`d.running` is computed server-side in `app/server/projections/agent-deployments.server.ts:130-151`
as *exactly* `state === 'running'` (a literal SQL `WHERE state = 'running'` join). The actual state
vocabulary (`db/migrations/0001_baseline.sql:402-403`) is `queued | running | finished | error |
interrupted` — "reserved" and "crashed" (from the task prompt) aren't literal states: a "reservation"
(`run-service.server.ts:668-671`) is adopted **directly into `state='running'`**, so it's correctly
counted; "crashed" maps to `error`/`interrupted`, correctly excluded. `finished`/`error`/
`interrupted` engagements correctly show as idle-if-still-assigned. **No false positive remains.**

Minor (low-severity) imprecision: a run **queued** behind the run-concurrency cap
(`admitRun`, `run-service.server.ts:1198-1212` — a real, potentially long-lived state once an admin
sets a cap) is lumped into "idle" exactly like a truly untouched engagement. Defensible ("not
literally executing" is true) but arguably undersells "actively waiting its turn" — the fix doesn't
distinguish `queued` from genuine idle anywhere in the label.

### ⚠️ The identical bug is still live one click away, on the same page, fed by the same data
The roster **sidebar** (`aside.profile-list`, always visible on `/agents`) shows each profile via
`ProfileItem` → `ActiveBadge`. Its count comes from `counts`
(`app/features/agents/agents-page.tsx:1322-1335`):

```ts
const counts = useMemo(() => {
  const sets = new Map<string, Set<string>>();
  for (const d of deployments) {
    ... keys.add(d.taskKey);   // every engagement counts — d.running is never read
  }
  ...
}, [deployments]);
```

`ActiveBadge` (`:148-172`) renders a **pulsing "working" indicator** (`<span className="working" />`
— the same visual device the just-fixed hero uses for real running work) plus the raw count whenever
`count > 0`, with no running/idle distinction at all. This is invoked at `:1529` (operator row) and
`:1556` (each specialist row).

This is not a theoretical near-miss: `counts` and the hero's `insts` are **provably the same
underlying data**, filtered differently —
`app/features/agents/agents-page.tsx:1586`: `insts={deployments.filter((d) => d.profileId ===
current.id)}`. The exact `d.running` boolean the hero now correctly consumes is sitting right there
in `deployments` when `counts` is built, four hundred lines earlier in the same file, and is simply
not read. Practical effect: open `/agents`, look at a profile assigned to (but not executing on) 3
tasks — the sidebar row shows a pulsing "working" badge with "3," and clicking into that exact
profile shows the corrected hero saying "idle · engaged on 3 tasks" one click later. The two halves
of the same page now disagree, which is the same class of incoherence `1cd86c8` set out to fix.
No test exercises this: the one roster-badge test in `agents-page.test.tsx:1932-1960` uses
`deployments={[]}`, so the nonzero-but-idle case was never asserted either way.

**Fix shape**: mirror `runningKeys`'s filter into the `counts` `useMemo` (or feed `ActiveBadge` a
running-vs-engaged pair the way `ProfileDetail` now gets one).

---

## 4. `4bc6078` (PR #207) — hero shows "input required" for an open decision packet — **SOLID**

### What the bug was / what the fix does
An **`input`**-type packet ("Decision required") sets `waiting = "human"` but leaves `readiness`
untouched — only `blocked` packets flip readiness directly. So a task with an open input packet
still read a green "ready" pill next to "Decision required," a visible contradiction. The fix adds
`displayReadinessWithPacket` (`app/shared/mapping/task.server.ts:428-453`), which lifts **display**
readiness `ready → input_required` when `waiting === "human"` and the open packet's `type ===
"input"`. Wired into `mapTaskProjectionRow` at `:550-554`; the stored `row.readiness` (returned
separately as `.readiness`) is untouched.

### Covers exactly the right cases, verified against the actual schema/render code
- **Packet types**: `app/schemas/task-file.schema.ts:479` — `type: z.enum(["input", "blocked"])`.
  Only two exist, so "does it cover blocked too" is moot by construction: `blocked` packets already
  set the **stored** `readiness = "blocked"` directly at open time
  (`app/server/tasks/operator-actions.server.ts:987-997`, comment literally: *"Blocked-ness lives on
  `readiness` alone"*) — verified in code, not just trusted from the fix's comment. A blocked task
  therefore never shows "ready" in the first place; no display-layer lift is needed or attempted for
  it.
- **"Risk" isn't silently left incoherent**: `inconsistency_risk_detected` renders `kind: "risk"`
  (`app/ui/pill.tsx:65`) — a visually distinct, already-alarming pill, not the green "ready" pill the
  bug was about. Scoping the lift to the `ready` case only (per the fix's own comment) is correct,
  not an oversight.
- **Board-card coherence, actually checked**: grepped every `ReadinessPill` call site in the app.
  There are exactly two that render a task's own readiness — the hero
  (`app/features/task-detail/task-main-sections.tsx:198-207`) and the board card
  (`app/features/board/board-page.tsx:551-556`) — and **both** read `task.displayReadiness`, never
  raw `readiness`. (The only other `ReadinessPill` use, `task-main-sections.tsx:67`, renders an
  unrelated diagnostics-finding `readinessEffect`, not the task's own state.)
- **Composes correctly with the pre-existing mid-run-yield rule (R21-8)**: both the hero and the
  board card already special-case `displayReadiness === "input_required"` to *yield* to an
  "agent working" pill while `waiting !== "human"` (hero) / `waiting === "agent"` (board). The new
  synthetic lift only ever fires when `waiting === "human"` (one of its three AND-conditions), which
  is exactly the condition that make the yield-branch **not** trigger — so the synthetic case always
  renders "input required" and never gets swallowed by the older yield logic. This also means reusing
  the existing `input_required` enum value (rather than inventing a new one) was the right call: it
  inherits this already-tested coherence machinery for free, and its pill styling (`kind: "input"`)
  matches the packet's own pill kind (`decision-packet.tsx:576`), so the readiness pill and the
  packet pill visually agree.
- **Gate/filter paths correctly untouched**: `board-page.tsx:917`'s accept-refusal-reason check
  reads `task.readiness` (stored), not display — confirmed it's the only board logic touching
  `readiness === "blocked"` for a gating decision, and it's unaffected by the display-only change, as
  the commit claims.
- Direct tests (`task.server.test.ts`) cover: ready+human+input → lifted; ready+no-packet → stays
  ready; ready+blocked-type-packet → not lifted (blocked already handles itself); blocked
  readiness+input packet → stays blocked (stronger signal wins); ready+packet but `waiting=agent` →
  not lifted (not the human's turn). All pass on HEAD.

No missed surface, no regression, no incoherence found between hero and board card.

---

## Summary table

| # | Commit | Verdict | Residual issue (file:line) |
|---|--------|---------|------------------------------|
| 1 | `f8333af` (+`d16f4b5`) | SOLID | none exploitable; note: rule is now accept-completion (admin/maintainer), not admin-only as `f8333af`'s own message says — see `d16f4b5`; maintainer can evict an admin's ownership without consent (intentional/tested) |
| 2 | `cdac955` | SOLID | none found |
| 3 | `1cd86c8` | RESIDUAL-GAP | `app/features/agents/agents-page.tsx:1322-1335` (`counts`) + `:148-172` (`ActiveBadge`) still count/pulse on ALL engagements, not just `d.running` — same bug, unfixed, one click from the corrected hero |
| 4 | `4bc6078` | SOLID | none found |
