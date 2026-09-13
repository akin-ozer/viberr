# Pass 37 — implementation plan

Branch `pass37/shopify-clone-fixes` on `akin-ozer/viberr`. Every item below names the
finding, the exact code, the change, and **the test that must be able to go red** — proved by
breaking the source, not by assertion.

Pre-prod rules apply: no migrations, no backwards compatibility, break things freely, tests
included.

## Proposed rulings

Numbers continue from 185.

- **186** — A dependency hold is a hard gate on dispatch (owner decision D37-1, F37-2).
- **187** — The canonical record distinguishes a pushed commit from a workspace commit, and
  never renders the second as the first (F37-8).
- **188** — A controller read returns what the equivalent human surface renders (F37-3, F37-5,
  F37-6, F37-7).

---

## C1 — The dependency hold becomes real  ·  F37-2  ·  ruling 186  ·  HIGH

**Owner's decision (D37-1):** hard gate, one spelling. A held task refuses **every** agent
dispatch, exactly as the archived/terminal gate does. No supporting-run carve-out.

### C1.1 Gate the dispatch

`app/server/tasks/specialist-run.server.ts`, in `startAgentRun`, immediately after the
ruling-177 closure block (~line 1215):

```ts
{
  const held = existing.parsed.frontmatter.blockedBy;
  if (held.length > 0) {
    throw AppError.validation(holdRefusal(input.taskKey, held, "running an agent on it"));
  }
}
```

`holdRefusal` is new and shared — put it beside `closureRefusal` so the two refusals read
alike and no door can drift. Sentence shape:

> SHOP-2 waits on goal-1 link 5 and Viberr is holding it, so running an agent on it is
> refused. Viberr releases it when every entry it waits on is done, or change what it waits
> on with Edit what it waits on.

Every door reaches this: the operator's `run_agent`, the controller's `run_agent`, the task
page's Run-an-agent control.

### C1.2 Make the pre-click surfaces say the same thing

Mirror U36-10's pattern for the closure gate: the task page's Run-an-agent control must be
disabled with this same sentence, so the words before the click match the server's answer.
`app/features/task-detail/execution-profile.tsx` already does this for stage ineligibility
(`stageIneligibilitySentence`) — add the hold beside it.

### C1.3 Stop the operator burning turns

`HELD_TRIGGERS` in `app/server/runtimes/operator-run.server.ts:290` is
`{create, transition, scheduled}`. With C1.1 in place a reactive turn can no longer dispatch,
so its only remaining useful act on a held task is answering a human. Narrow the exception to
exactly that: keep `agent-reply`, a human comment and a resolved packet driving; refuse
`pr-diverged` and `goal-edit` the way `create` is refused. The held doctrine text stays (it
is still right for the answering turn) but stops being load-bearing.

### Tests — each must go red when the source is broken

1. `app/server/tasks/specialist-run.server.test.ts` — "ruling 186: a held task refuses an
   agent dispatch". Build a task through the real writers, `setDependencies` it onto an
   unfinished entry, `installFakeRuntime()`, call `startAgentRun`, assert it rejects with
   status 400 **and** `startedRunSpecs()` is empty. *Red when:* the gate block is deleted.
2. Same file — "the refusal names the entries it waits on", asserting the entry string
   appears in the message. *Red when:* `holdRefusal` is replaced by a generic sentence.
3. Same file — "a released task dispatches again": satisfy the dependency, let
   `releaseDependents` clear it, assert the dispatch now succeeds. *Red when:* the gate reads
   a stale list rather than the live file.
4. `app/server/controller/controller-toolkit.server.test.ts` — the controller's `run_agent`
   takes the same refusal. *Red when:* the gate is put in a route instead of the chokepoint.
5. `app/features/task-detail/execution-profile.test.tsx` — the control renders disabled with
   the server's sentence. *Red when:* C1.2 is skipped.

---

## C2 — A workspace commit is never rendered as a repository commit  ·  F37-8  ·  ruling 187  ·  HIGH

**The defect.** `task.md` records `github.commits[].sha` for a commit that lives only in a
run's workspace clone. The clone is disposed; the record is not. The GitHub page then renders
"1 commit" and the board shows a branch with work on it.

### C2.1 Give a recorded commit a standing

Extend the `github.commits[]` entry in `app/schemas/task-file.schema.ts` with
`standing: "pushed" | "workspace"`. The vocabulary already exists in
`app/server/tasks/workspace-refresh.server.ts` (`"unpushed" | "ahead" | "in_sync" | "diverged"`)
— reuse its derivation rather than inventing a second one. Pre-prod: no migration, change the
schema and the writers together; a file without the key parses as `"workspace"` (the
conservative reading, since a pushed commit is always confirmable and an unconfirmed one must
never claim to be pushed).

### C2.2 The reconciler is the confirmer

`app/server/github/github-reconciler.server.ts` already fetches the branch's real commits. On
each reconcile: mark an entry `pushed` when the remote has that sha; when the remote does not
have it **and no workspace holds it**, drop it and write a typed timeline event saying so —
the work is gone and the record must say the word:

> The commit `3aad6ff` recorded for `shop-2` is on no branch and in no workspace. It was
> committed in a run's workspace and never delivered; that workspace is gone, so the change
> it held is lost. The task's goal is unchanged and can be run again.

### C2.3 Every renderer states which kind it counts

- GitHub page branch table (`app/features/github/*`): "1 commit" becomes "1 commit ·
  not pushed" for a workspace standing; a lost entry renders as "no commits".
- Board card and task page: a branch whose only commits are `workspace` does not read as
  delivered work.
- `insights-query.server.ts` already counts this correctly (traceability) — leave it, and
  cite it in the code comment as the surface that got it right first.

### Tests

1. `app/server/github/github-reconciler.server.test.ts` — "ruling 187: a recorded commit the
   remote does not have, with no workspace holding it, is dropped and announced". Use
   `fakeGithubFetch` to answer a branch whose commit list lacks the sha. Assert the entry is
   gone from `task.md`, a typed timeline event exists, and its text names the sha and the
   branch. *Red when:* the drop is removed, or the event is not written.
2. Same file — "a commit the remote HAS is marked pushed". *Red when:* the standing is
   hard-coded.
3. `app/shared/mapping/task.server.test.ts` — a summary built from a workspace-only commit
   list reports no delivered commits. *Red when:* the mapping ignores standing.
4. `app/features/github/github-page.test.tsx` — the branch row renders the unpushed wording.
   *Red when:* C2.3 is skipped.

---

## C3 — A controller read returns what the human surface renders  ·  F37-3, F37-5, F37-6, F37-7  ·  ruling 188  ·  MED

One family, one ruling, four call sites. All in
`app/server/controller/controller-toolkit.server.ts`.

### C3.1 `get_project` reports resolved eligible stages (F37-3)

`assembleAgentRoster` returns `stages: def?.stages ?? template?.stages ?? []` — the raw
declaration. Emit the board-resolved list through the **shared**
`resolveDeclaredStages(declared, stages, workflow)` that `agents-page.tsx`,
`execution-profile.tsx` and the dispatch gate already use, and keep the raw list beside it as
`declaredStages` so a remap is visible rather than silent.

*Test:* `controller-toolkit.server.test.ts` — a profile declaring `ready`/`impl` on a board
with neither reports the resolved board stages and flags the remap. *Red when:* the raw list
is emitted.

### C3.2 `get_task` stops leaking a stage-filtered column (F37-5)

`validation_block_reason` is documented as stage-unaware because "every consumer filters rows
… on the resolved review stage before it ever looks at this column". `get_task` does not.
Replace the raw `blockReason` with a resolved `acceptance: { canAccept, reason }` computed
through the same precedence `boardAcceptRefusal` uses (`atAcceptanceBoundary` first).

*Test:* a Design-stage task with a required-reviewer gate pending reports the stage reason,
not the Review-stage sentence, and never the word "force-accept". *Red when:* the precedence
is reordered or the raw column is restored.

### C3.3 `list_mcp_servers` reports the write-tool marking (F37-6)

Add `writeTools: string[]` plus the derived sentence the Org settings row shows ("N write
tools withheld from read-only runs"). State ruling 176's enforcement in the tool description
so a model granting a server knows what the marking does.

*Test:* a server with marked tools reports them. *Red when:* the field is dropped.

### C3.4 `save_mcp_server` can govern what it creates (F37-7)

Add `writeTools?: string[]`. On **create** with the parameter absent, apply the same
`looksLikeWriteTool` default the editor pre-ticks, so a controller-created server is no less
governed than a human-created one. Return the resolved marking in the reply. Keep the update
sentinel (`undefined` = leave unchanged) exactly as it is.

*Test:* a server created through the controller with no `writeTools` lands with the heuristic
default, and one created with an explicit list lands with that list; an update omitting the
field preserves the existing marking. *Red when:* the default is dropped (the created row
comes back with a null policy — the exact live symptom).

---

## C4 — The sync pill cannot go stale when `main` moves  ·  F37-9  ·  MED

`github-reconciler.server.ts:897`: `changed` compares only `fm.pr` and `fm.github`, so a
`sync` flip persists nothing and the poller (`skipUnchangedProvenance: true`) writes no
provenance row. The UI reads provenance. Fix: treat a changed compare verdict as a reason to
refresh the sync fields — update the existing observation row rather than appending one, so
the "grow unboundedly" concern the current comment names is untouched.

*Test:* `github-reconciler.server.test.ts` — reconcile a branch as `synced`, move the base so
the next reconcile measures `behind_main` with no task-file change, assert the surface the
pill reads now says `behind_main`. *Red when:* the sync refresh is removed.

---

## C5 — The write-tool heuristic learns the common mutation verbs  ·  F37-4  ·  LOW

`WRITE_VERBS` in `app/shared/mcp-tools.ts` is seven words and misses `edit_file` and
`move_file` on a stock filesystem MCP server. Add at least `edit`, `move`, `rename`, `patch`,
`append`, `put`, `insert`, `upsert`, `replace`, `set`, `drop`, `truncate`. The word-splitting
around it is already correct and stays.

*Test:* `app/shared/mcp-tools.test.ts` has positive/negative tables — extend the positive one
with the real names from this pass (`edit_file`, `move_file`, `renameFile`, `patch_document`)
and keep a negative guard so `moved_at` / `settings` do not match. *Red when:* the new verbs
are removed.

---

## C6 — WITHDRAWN  ·  F37-1

Not implemented, deliberately. `log-noise.ts` already collapses telemetry in the console and
says it is doing so, and the stored row is what `{ } raw` exists to show. Measured over the
whole pass, telemetry is 13% of rows and 1.5% of bytes — not the flood one early turn
suggested. Dropping the rows would break a documented honesty contract to save 70 KB.

## Validation for every item

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Each test proved red by breaking its source, then green again — recorded in `VALIDATION.md`
  with the exact break used.
- The live app rebuilt from this branch and re-driven through the UI for C1, C2 and C4, with
  screenshots.
- Docs updated in the same change: `docs/architecture/decisions.md` (rulings 186-188),
  `docs/domain/task-lifecycle.md` (the hold gate), `docs/domain/github-delivery.md` (commit
  standing, the sync pill), `docs/domain/controller-and-goals.md` (the four tool changes).
