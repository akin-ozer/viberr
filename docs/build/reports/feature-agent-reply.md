# Feature — Comment to an agent, resume its session, reply as a comment

Commenting on a task and **@mentioning a named agent** now resumes **that
agent's existing provider session** (not a fresh one) and, when the run
finishes, posts the agent's reply back into the task's timeline as an
**agent-authored comment**. The first @mention of an agent that has never run
on the task falls back to starting a fresh specialist run so it still replies.

Gates at close: `npm run typecheck` clean, `npm test` **799/799** (783 prior +
16 new), `npm run build` clean. `./data` and `./docker-data` were **NOT**
modified and no commit was made (verified: `git status --short data/
docker-data/` empty; latest commit predates this work).

## Behavior

### 1. Agent-mention resolution — `resolveMentionedAgent`

`app/server/tasks/agent-reply.server.ts` →
`resolveMentionedAgent(db, ctx, projectSlug, taskKey, text)` returns the target
agent's identity (`profileId`, `name`, `role`, `backend`, `model`, `actorRef`)
plus its resumable **`session`** (the most-recent non-operator run row on the
task that has a `session_id`), or `session: null` when it has never run here.
Returns `null` when the comment mentions no agent.

A comment may target an agent by:

- **name / profile id** — `@dev` (matches a deployed specialist's `name` or
  `id`, case-insensitive);
- **backend** — `@claude` / `@codex`;
- **role / generic** — `@operator`, `@agent` → the task's **primary
  specialist** (from `specialist` frontmatter).

Resolution precedence: generic `@agent`/`@operator` → primary specialist first;
then a deployed specialist by name/id/backend; then a bare backend handle that
matches the primary. `@agent` is intentionally NOT matched against every
specialist by name so a two-specialist task never ambiguously matches both.

### 2. Comment → resume that agent's session — `commentToAgent`

`app/server/tasks/task-actions.server.ts` → `commentToAgent(...)` is a
**superset of `appendComment`** (plain comments behave exactly as before):

1. Resolve the mentioned agent (before appending, so a named mention like
   `@dev` still flags the comment as routed-to-agent — `AGENT_HANDLE_RE` alone
   only matches the reserved `agent|operator|codex|claude` handles).
2. Append the user's comment (existing behavior + mention fan-out). When an
   agent is resolved, the comment is written with **`toAgent: true`** via a new
   optional `forceToAgent` on `appendComment`.
3. **RBAC** — triggering a run is a runtime action, gated to **admin |
   maintainer** (mirrors specialist runs, contracts §3.2). A viewer/reviewer
   @mention still **records the comment** but does **NOT** trigger the run —
   `commentToAgent` returns `runtimeDenied: true` and never throws for a
   well-formed comment (the route toasts about it).
4. **Resume vs fresh:**
   - **Has a prior session →** `resumeRun` with a follow-up prompt built from
     the comment, reusing the original run's **clone workdir**
     (`<taskDir>/workspace/<repo>` if it still exists, else the bare task dir —
     `resumeWorkdir`). Autonomous.
   - **No prior session →** start a **fresh** specialist run (assign the
     specialist first if the task has none, then `startSpecialistRun`) so the
     first @mention still gets a reply. Autonomous.

The follow-up prompt:

> A human (`<name>`) commented on task `<KEY>` ("`<title>`"): "`<comment>`".
> Respond to their comment directly. Continue or adjust your work on the
> repository in your working directory as needed, then give a concise reply.

### 3. Agent replies in the comment section (completion registry)

**run-service** gained a lightweight in-process completion registry
(`app/server/runtimes/run-service.server.ts`):

- `registerRunCompletion(runId, cb)` stores an opaque callback in a
  process-global `Map` (kept on the same `Symbol.for("viberr.runService")`
  state as the live handles).
- `launch()`'s `onExit` hook, **after `sink.finalize(exit)`**, reads the
  finalized run row and invokes the callback once, then deletes it. Failures in
  the callback are caught + logged (never break run teardown).

run-service stays **decoupled** — it invokes an opaque callback and never
imports task-actions. `commentToAgent` registers a callback that:

- reads the run's final text via `replyTextForRun` → `extractReplyText`
  (prefers the last substantial `assistant` / `agent_message` line, falls back
  to the `result` text, whitespace-normalized, truncated to 1200 chars — the
  full transcript stays in the agent logs), and
- appends it as an **agent-authored `comment` event** (actor = the agent's
  `actorRef`, `type: "comment"`, **NOT** `toAgent`) → reproject → SSE rides the
  file write. Audited as `task.agent.replied`.

The comment write in the callback is fire-and-forget with a `.catch` (the
completion callback is synchronous — fired from `onExit` — so it cannot await
`updateTaskFile`, which is async and runs under the per-file mutex).

### How the reply renders

`app/features/task-detail/timeline.tsx` already renders a `comment` event whose
`actor.kind === "agent"` correctly: the comment-card body, the agent identity
(`Claude Code · developer`, resolved by `createActorResolver` +
`agentBackendName`), and the `agent` pill (rendered whenever the actor is an
agent, independent of event type). **No render change was needed** — a jsdom
smoke test locks this in.

### 4. Route / UI

`app/routes/project.task.tsx` intent `comment` now calls `commentToAgent`.
Toast copy:

- agent engaged → `Comment posted · @<name> is picking it up`;
- agent mentioned but role can't trigger → `Comment posted · your role can't
  trigger agent runs`;
- reserved-handle route without a resolved agent → `Comment posted · routed to
  mentioned agent` (unchanged);
- plain comment → `Comment posted` (unchanged).

No new UI control — the composer already exists; the reply arrives as a new
comment via SSE revalidation.

## Files

| File | Change |
| --- | --- |
| `app/server/tasks/agent-reply.server.ts` | **new** — `resolveMentionedAgent`, `extractReplyText`, `replyTextForRun`, `buildReplyScript`, `resumeWorkdir` |
| `app/server/tasks/task-actions.server.ts` | **new** `commentToAgent` + `forceToAgent` on `appendComment`; agent-reply-comment poster + RBAC/repo helpers |
| `app/server/runtimes/run-service.server.ts` | completion registry (`registerRunCompletion`, `RunCompletionCallback`, `onExit` fires it); `resumeRun` now forwards `workdir`/`autonomous` and mints a fresh (collision-free) thread id carrying the prior `session_id` |
| `app/routes/project.task.tsx` | `comment` intent calls `commentToAgent`; enriched toast copy |
| `app/server/audit/audit-actions.ts` | `task.agent.replied` (scope `task`) |
| `app/features/task-detail/timeline.tsx` | unchanged (verified it already renders agent comments) |
| `app/server/tasks/agent-reply.server.test.ts` | **new** — 15 tests |
| `app/features/task-detail/task-detail-components.test.tsx` | +1 jsdom test (agent-authored comment renders) |
| `app/features/task-detail/task-detail-route.server.test.ts` | updated 2 routing tests for the new trigger behavior (run-isolated) |

## Tests (16 new)

`agent-reply.server.test.ts` (15): mention resolver (no-mention, name, backend,
generic `@agent`/`@operator`, agent-without-session, agent-with-session);
`extractReplyText` (assistant-preferred / result-fallback / null / truncation);
`commentToAgent` (plain comment superset; `@dev` flags routed; **fresh** run →
agent-authored reply comment lands with the agent actor + `task.agent.replied`
audit; **resume** reuses the prior `session_id` in a NEW run row; viewer +
reviewer @mention records the comment but triggers no run). Component (+1):
agent-authored comment renders the agent identity + pill in a comment card.

All runs in tests use `configureRunServiceForTests()` (simulated engine, offline
+ deterministic); the reply run uses an `instant` scripted stream so the reply
lands promptly. The fresh-run test tolerates `startSpecialistRun`'s realistic
1–3.2s cadence with a generous timeout.

## RBAC

Commenting is app-wide (any registered user, existing behavior). **Triggering**
an agent run reuses the specialist-run gate: **admin | maintainer** against
project membership. A lower role's @mention is recorded as a comment,
`runtimeDenied` is returned, and no run starts (no throw).

## Fallbacks / gotchas

- **Resume workdir reuse.** `resumeRun` gained a `workdir` param; `commentToAgent`
  passes `resumeWorkdir(...)` = the specialist-run clone
  (`<taskDir>/workspace/<repo>`) when it still has a `.git`, else the task dir.
  Without this the resumed run would default to the bare task dir and lose the
  checkout.
- **`resumeRun` thread id.** `agent_runs` is unique on
  `(project_slug, task_key, thread_id)`, so a resume can NOT reuse the prior
  row's thread id. `resumeRun` now mints a fresh `"<prevThread>-r<rand>"` thread
  id (recognizably grouped) while forwarding the prior **`session_id`** — a new
  stream that shares the provider session, matching how both CLIs re-emit a full
  stream on resume.
- **Restart caveat.** Completion callbacks live only in this process's registry.
  If the server restarts while a reply run is mid-flight, the pending callback
  is lost and that run's reply comment is not posted — **acceptable**: the full
  transcript still lives in the agent logs, and a later @mention resumes the
  session again. (In-process only; not persisted by design.)
- **No text → no comment.** If a run produces no usable assistant/result text
  (e.g. it was interrupted early), the callback logs and posts nothing rather
  than an empty comment.
- **Fresh-run prompt.** The no-session fallback reuses `startSpecialistRun`,
  which builds its own *analyze-the-repo* prompt (not the follow-up prompt); its
  findings become the reply. Only the **resume** path carries the comment-derived
  follow-up prompt. This is the documented trade-off of reusing the existing
  specialist-run path for the first-mention case.
- **Role round-trip.** An agent `actorRef` role is written as a slug
  (`agent:claude/developer`) and re-parsed title-cased (`Developer`) by the file
  actor-ref codec — same as every other agent event.

## Verify end-to-end (containerless / CTL-1, the `dev` agent)

Signed in as the containerless admin (`u_bGyO9Ri4Nbo_`), CTL-1 already has the
`dev` specialist assigned. A comment intent that @mentions `dev`:

```
POST /projects/containerless/tasks/CTL-1
Content-Type: application/x-www-form-urlencoded

_csrf=<token>&intent=comment&text=@dev please re-check the parser edge case
```

Expected:

1. The comment is recorded immediately with the routed-to-agent tint; the action
   returns `toast: "Comment posted · @dev is picking it up"`, `triggered:
   "resumed"` if `dev` has a prior session on CTL-1, else `"started"`.
2. In the UI (`/projects/containerless/tasks/CTL-1`) the run streams in **Agent
   logs**; when it finishes, a **new agent-authored comment** from
   `Claude Code · developer` appears in the **Comments** filter of the timeline
   (arriving via SSE revalidation — no page reload).
3. A `dev`-mention by a viewer/reviewer records the comment but does not start a
   run (`toast: "Comment posted · your role can't trigger agent runs"`).

(Do this against a scratch task, not real work — it starts a real/simulated run.
The demo machine has no backend keys, so the run is simulated and the reply is
the scripted follow-up text.)

## Deviations

- Timeline component needed **no** change — it already renders agent comments
  with the agent glyph/name/pill; only a smoke test was added.
- Two existing route tests (`@operator`/`@codex` routing) were updated to reflect
  the new trigger behavior and to isolate the triggered runs (simulated engine +
  interrupt), since `@operator`/`@codex` on a task that carries a specialist now
  legitimately engages the agent.
