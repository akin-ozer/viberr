# G-D-routes-operator — adversarial verification

Branch `pass15/product-fixes`, dirty tree, verified 2026-07-29 against
`HEAD = 5e8b000` (wave-2 already committed; the gap-repair work is the working
tree on top of it). Every revert experiment was undone by copying back a
pre-experiment byte copy and re-checking the sha.

## Gates

| gate | result |
|---|---|
| `npm run typecheck` (`react-router typegen && tsc`) | clean, **no output** |
| stream's 5 own test files | **5 files / 109 tests passed** |
| consumer sweep (`app/routes/project-visibility…`, `app/features/runtime/`, `app/features/task-detail/`, `app/features/policy/`, `operator-run`, `operator-actions`, `task-actions`) | **22 files / 379 tests passed** |
| `app/features/runtime/` under `TZ=Asia/Tokyo` | 7 files / 58 passed (the TZ pin does not leak) |

Restored shas after all experiments (identical to pre-experiment copies):

```
0fc8a2f5  app/routes/project-visibility.server.ts
6bd96a99  app/routes/project-visibility.server.test.ts
2c5f34b8  app/routes/project.task.tsx
e3cd02d7  app/routes/project.policy.tsx
fda87c79  app/features/runtime/log-clock.ts
29ffdd8b  app/features/runtime/runs-panels.tsx
559d35f8  app/server/runtimes/operator-run.server.ts
```

## Per-claim verdicts

### S6-1 (R15-4 action side) — **CONFIRMED as a fix; PARTIAL is right but UNDERSTATED**

The gate is real and the canary is real. Stubbing `requireVisibleProject` to
`return;` (`app/routes/project-visibility.server.ts:34`) produced **5** failures,
one more than the ledger names:

```
× task detail: a non-member is refused as an unknown slug
× policy: a non-member is refused as an unknown slug
× R15-4: a NON-MEMBER's comment is refused with the unknown-slug 404
× rejects non-members entirely (R15-4: as an unknown slug, not a 403)
× non-members are denied ownership; hand-off to a non-member is denied
AssertionError: expected 400 to be 404
AssertionError: expected undefined to be 404
AssertionError: expected 403 to be 404
AssertionError: expected 403 to be 404
 Test Files 2 failed (2) | Tests 5 failed | 40 passed (45)
```

Placement is correct: the gate is outside the `try`
(`app/routes/project.task.tsx:299`, `app/routes/project.policy.tsx:43`) so the
refusal stays a thrown `Response`, and `assertProjectAction("any-member", …,
{allowArchived:true})` keeps the D2 org-admin override (`project-authority.server.ts:181-203`)
and the P13-D-8 denial row (`:208-226`).

The four-route deviation is accurate — the named sibling assertions really do
expect 403: `app/features/shell/workspace-routes.server.test.ts:394`,
`app/features/project-settings/settings-route.server.test.ts:437`,
`app/features/github/github-route.server.test.ts:213`,
`app/features/agents/agents-route.server.test.ts:128`. All intents on those four
routes are role-gated (e.g. `app/routes/project.board.tsx:26-81`), so the residue
there is existence-confirmation, not a write.

**What the claim misses (see gap 1): the same hole is open on the READ side, in
this stream's own file.**

### S6-2 (log-clock) — **CONFIRMED**, all three canaries reproduce verbatim

| canary | observed |
|---|---|
| `localLogClock` → `return t` (pre-fix), `TZ=UTC` | 4 failed / 2 passed — `expected '17:46:46' to be '19:46:46'`, `'00:05:12'→'02:05:12'`, `'17:00:00'→'18:00:00'`, `'17:41:00'→'19:41:00'` |
| nearest-day rule restored (`if (false)` on the anchored branch) | 1 failed — `× anchors a long run's line FORWARD` / `expected '19:00:00' to be '18:00:00'` |
| wiring reverted (`runs-panels.tsx:586` → `{entry.line.display.t}`) | 1 failed — `× renders each line's clock in the VIEWER's zone` / `expected [ '17:46:46' ] to include '19:46:46'` |

The "pinned zone is in effect" guard is genuine (`log-clock.test.ts:26-30`
asserts `-120` / `-60`), so the suite cannot go vacuous again, and the whole
`app/features/runtime/` directory still passes under `TZ=Asia/Tokyo` — the
`beforeAll`/`afterAll` and `try/finally` restores do not leak.

### S3-1 (packet-replacement clause + coalescing) — **CONFIRMED as tested; the underlying replacement is untouched**

| canary | observed |
|---|---|
| clause removed (`operator-run.server.ts:1749-1751` → `"" +`) | `× S3-1: a question answered while a packet is open…` / `expected 'You are operating VIB-6, "Improve the…' to contain 'A decision packet is ALREADY OPEN'` |
| coalescing disabled (`if (false && by && …)`, `:252`) | `× S3-1: consecutive questions from the SAME human are ONE turn` / `expected '# Task snapshot\n\n\`\`\`json\n{\n  "key…' to contain 'the second'` |

`snapshot.openPacket` is real (`operator-actions.server.ts:859`,
`openPacket: !!file.parsed.packet`), the prompt-builder arg order in the new test
is correct (`buildOperatorTurnPrompt(snap, trigger, humanComment, agentReply,
humanCommentBy, …)`, `:1886-1894` — `"Arda"` lands in slot 5), and the merge
cannot corrupt an in-flight turn because `takePendingTrigger` **shifts** the
entry out before the drive starts (`:284-292`) while the merge targets
`[length-1]`. Merged text is oldest-first, as claimed.

### S3-2 (gate on the goal-updated turn) — **CONFIRMED**

Splicing `triageQualityGate(snapshot)` out of the `goal-updated` branch
(`:1759-1767`) fails both new cases:

```
× F15-14: the GOAL-EDIT turn carries the gate — a still-vague edit buys no move
× F15-14: the Codex goal-edit turn carries it too
expected 'You are operating VIB-6, "Improve the…' to contain 'TRIAGE QUALITY GATE'
expected '# Task snapshot\n\n```json\n{\n  "key…' to contain 'TRIAGE QUALITY GATE'
```

The branch is genuinely live: `goal-updated` is dispatched with **no**
`humanComment` (`task-actions.server.ts:599` → `autoInvokeOperator(…,"goal-updated")`,
`:609-643` passes no comment), so the earlier `humanComment` early-return does
not shadow it. Stage scoping is real (`triageQualityGate` returns `""` off the
entry stage, `:1715-1720`).

---

## The 3 most dangerous remaining gaps

### 1. (HIGH) R15-4 is still open on the READ side, through the same mechanism the fix documents

`app/routes/project-visibility.server.ts:10-14` correctly names the defect:
"React Router runs a child route's ACTION without its parent's loader". The
mirror on the read side was not considered, and it is attacker-controllable:

`node_modules/react-router/dist/development/lib/server-runtime/single-fetch.js:79-84`

```js
let routesParam = new URL(request.url).searchParams.get("_routes");
let loadRouteIds = routesParam ? new Set(routesParam.split(",")) : null;
… filterMatchesToLoad: (m) => !loadRouteIds || loadRouteIds.has(m.route.id),
```

So `GET /projects/<slug>/tasks/<key>.data?_routes=routes/project.task` runs the
CHILD loader only and never `routes/project`'s membership gate
(`app/routes/project.tsx:64-76`). `app/routes/project.task.tsx:94-102` has no
membership check of its own — only the run projection is member-scoped
(`:126-130`), and its comment at `:113` still states the pre-ruling doctrine:
"the task page is READABLE app-wide by design (anyone may open a task and
comment)", 185 lines above the action gate that says the opposite.

Proven live, not inferred. A temporary probe appended to
`project-visibility.server.test.ts` (run, then the file restored byte-for-byte,
sha `6bd96a99`) called the child loader as non-member Deniz:

```
PROBE non-member sees: {"title":"Attach execution workspace to task runtime",
"goal":"Let the operator attach a single GitHub repo to a task, create the
task-key branch, and reflect branch + PR state back into the canonical task
file without treating GitHub as the source of truth."}
```

Title, goal, timeline, recommendations, schedules, mentionables and the deployed
specialist roster all cross to a non-member. R15-4 ("non-members cannot open
boards/tasks (404-style); WI-13 secrecy wins") is therefore **not satisfied**,
and the ledger's PARTIAL disclosure describes only the four 403 routes — the
read leak is undisclosed. The same `_routes` trick reaches `routes/project.policy`'s
loader, which answers with a 403 that names the project
(`require-project.server.ts:38-40`), whose own doc comment (`:11-13`) still
asserts the retired FR4 app-wide-readability rule that this stream just amended
in `app/shared/rbac.ts:46-53`. The fix has to be the same one-liner in each child
LOADER, or a route-module-level guard — not more per-action patches.

### 2. (MED) The coalescing merge keys on a DISPLAY NAME while the queue is holding the user id

`app/server/runtimes/operator-run.server.ts:251-259`

```js
const by = input.humanCommentBy?.trim();
if (by && previous && previous.humanCommentBy?.trim() === by) {
  queue.humanComments[queue.humanComments.length - 1] = { ...input, humanComment: … };
```

`humanCommentBy` is `userName(db, actor.userId)` (`task-actions.server.ts:1044`)
— a display name, not an identity. Two users who share a display name (the exact
condition B-FD2 records as live: "@arda notifies every Arda") have their
questions **merged into one turn**, and because the survivor is `{...input}` the
older person's `actor` (`RunOperatorInput.actor`, `:139`) is replaced wholesale:
their question is answered as if the other person asked it, and the NEW-4 @tag
notifies the wrong one. The queue already carries `input.actor.userId`, so the
merge key is available and was not used. Related, smaller: the merged text has
no length bound (8 queued turns × unbounded prose), and a merged entry silently
adopts the newer entry's `trigger`.

Also note the mitigation is prompt-only where the gap asked for it to be:
`operator-actions.server.ts:590-591` still does `parsed.packet = packet`
unconditionally, so a model that ignores the new paragraph reproduces the
"replaced by a newer one" stranding exactly as before. Defensible (the gap text
proposed this mitigation), but the ledger's **DONE** overstates it — there is no
server-side refusal and no test can catch the model ignoring the sentence.

### 3. (MED) F15-14's gate still misses the most common triage turn, and now contradicts itself

`operatorTurnInstruction` returns EARLY on any `humanComment`
(`operator-run.server.ts:1740-1757`) — before both `triageQualityGate` call
sites (`:1765` goal-updated, `:1839` generic). So the single most likely triage
interaction, a human typing "@operator ok go ahead" on a vague triage task,
carries **no** gate at all. The goal-edit hole was closed; the comment hole was
not, and nothing pins it.

Where the gate now does land on `goal-updated`, it reads against its own
sentence: the branch says "*state the missing input once; do not open a
duplicate packet*" and the appended gate says "*or `open_decision_packet` (type
"input") proposing 2–4 concrete scopes*" (`:1721-1728`). In the literal F15-14
scenario — human edits a still-vague goal while the scope packet is open — the
operator is told both not to open a packet and to open one. A contradictory
directive is the failure mode F15-14 is about.

## Lesser notes (non-blocking)

1. **Audit signal narrowed for non-members.** Every refusal now comes from the
   gate, so the P13-D-8 row records `action: "any-member"` /
   `what: "act on this project"` (`project-authority.server.ts:216-226`) instead
   of the intent the deeper guard used to name (`resolve-packet`, `owner-take`,
   …). NFR10's "who probed above their role, **and at what**" is coarser for
   exactly the actors most worth watching. Members with an insufficient role are
   unaffected.
2. **Forward-only anchoring is bounded to +24 h.** `log-clock.ts:52-54` adds at
   most one `DAY_MS`, so a run longer than 24 h re-acquires the wrong-calendar-day
   behaviour the fix removed (rendered `HH:MM:SS` still only diverges across a
   DST edge). The old rule was wrong past 12 h; the new one past 24 h. Worth one
   sentence in the header comment, which currently reads as if the class is closed.
3. **Extra `project.md` read per project-scoped action.** `requireVisibleProject`
   → `assertProjectAction` → `readProjectFile` on every POST, in addition to
   whatever the intent already reads. No correctness impact.
4. `project.task.tsx`'s action passes no `dataRoot` to the gate while the rest of
   the file threads `ctx`; harmless today (both resolve the global root) but it is
   the kind of split that bites in a test harness.
