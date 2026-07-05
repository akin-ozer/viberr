# Fix — three task-detail UI bugs (markdown replies, grouped agent logs, comment auto-select)

Three defects in the task-detail workspace, fixed together because they all
touch the runtime/comment surface:

1. **Agent replies rendered as a blob** — real markdown (lists, tables,
   newlines, emoji) collapsed to one line by the inline-only `RichText`.
2. **The Agent-logs dropdown listed one entry per run row** — every resume
   minted a new thread, each shown as its own entry labeled by the backend
   ("Claude Code") instead of the agent's name.
3. **Commenting an agent didn't surface its live output** — the user had to
   hunt for the right log stream.

Gates at close: `npm run typecheck` clean · `npm test` **867/867** (846 prior +
21 new) · `npm run build` clean. `./data` / `./docker-data` untouched, no
commit, container not rebuilt.

---

## BUG 1 — markdown comment bodies

### Approach

- New deps `react-markdown@^10.1.0` + `remark-gfm@^4.0.1` (versions verified via
  `npm view`; GFM covers paragraphs, hard/soft line breaks, bullet/ordered
  lists, tables, headings, fenced/inline code, bold/italic, links; emoji are
  unicode and pass through).
- New component **`app/ui/markdown.tsx`** — `<Markdown text={...}/>`:
  react-markdown with `remarkPlugins={[remarkGfm]}`, **NO raw HTML** (the
  react-markdown default escapes raw HTML rather than executing it — safe for
  untrusted agent/user text), a `components` map that:
  - renders `code` with `className="mono"` (shared mono chip),
  - wraps `table` in a `.md-table-wrap` (`overflow-x:auto`) so wide tables
    scroll instead of blowing out the card/page width,
  - renders links with `target="_blank" rel="noopener noreferrer"`.
- **`app/features/task-detail/timeline.tsx`** — `comment` events (agent replies
  AND user comments, both multi-line) now render through `<Markdown>` wrapped in
  `.md-body`. The single-line **typed** events (transition/agent/quality/policy/
  github/completion/assign/blocked) keep `RichText` verbatim.
- **`app/app.css`** — scoped `.md-body` block in the marked `/* === app
  additions === */` section: paragraph/list/table/heading/code/blockquote/hr
  spacing using existing `--fg`/`--muted`/`--hairline`/`--blue-pressed` tokens.
  No Tailwind, no inline hex.

### @mention decision

Mentions **inside a comment** render as **plain text** (the markdown AST has no
mention concept, and a rehype re-chip step isn't worth it on this surface). The
`@mention` chip is still rendered by `RichText` on the single-line typed events.
This is the documented trade-off; the one existing test that asserted a
`.mention` span inside a comment was updated to assert the plain-text +
`.md-body` behavior.

---

## BUG 2 — one Agent-logs entry per agent, named by the agent

### Run-identity migration

`db/migrations/0010_run_agent_identity.sql` adds two **nullable** columns to
`agent_runs`:

- `agent_name TEXT` — the deployed profile's display name ("dev", "Operator",
  a consultant's name);
- `agent_profile_id TEXT` — the stable per-agent grouping key.

Seed/historical rows carry null on both (handled via fallback, below).

`StartRunInput` gained optional `agentName?`/`agentProfileId?`, persisted on the
row by `upsertRun` (INSERT + ON-CONFLICT + params updated). Set from:

- `startSpecialistRun` → the specialist's resolved profile **name** + id
  (e.g. `"dev"`/`"dev"`);
- `scheduleOperatorRun` → `"Operator"`/`"operator"`;
- `resumeRun` → **carries the prior run's** `agent_name`/`agent_profile_id` by
  default (caller may override — `commentToAgent` passes the current profile
  name/id so a reply run is always named even when resuming a seeded session).

### Grouping algorithm (`app/server/runtimes/run-projection.server.ts`)

`projectRunsForTask` now returns **one RunView per agent**:

- **Group key**: operator → `"operator"`; else `` `${kind}:${agent_profile_id ??
  role}` `` (the `?? role` fallback keeps null-identity seed rows grouped by
  their distinct role, preserving the seeded op/primary/c0 shape).
- **Representative** per group = the run that is `running` if any, else the
  **most-recently-created** (rows arrive created_at ASC → last seen is newest).
  The representative supplies `RunView.id` (selection key/thread) + `serverRunId`
  — so a running representative keeps the Live-run strip working, and the newest
  run (a fresh reply) becomes the selectable entry.
- Group order preserves first-seen (created_at ASC) so the entries stay in a
  stable, expected order.

`who.name = agent_name ?? WHO_NAME[backend]` (operator: `agent_name ??
"Operator"`) — the picker button + option rows + the panel header all show the
agent's name, with role/sdk as the secondary line (unchanged).

### Fallback for null `agent_name`

A seed/historical run with null identity groups by `kind:role` and labels by the
backend `WHO_NAME` (`"Claude Code"`/`"Codex"`) — nothing regresses. The seed
tests (VIB-142 `["op","primary","c0"]`, VIB-151 2 running + 1 op) stay green
because each seeded run has a distinct role/kind → distinct group → one
representative each.

The `LiveRunPanel` and `AgentLogsPanel` both consume the same grouped list
(they already take `runtime: RunView[]`), so a running representative keeps the
strip and console live.

---

## BUG 3 — commenting an agent auto-selects + streams its log

- `commentToAgent` now returns **`logThreadId`** — the grouped `RunView.id` the
  reply run appears under (`resolveReplyLogThread` projects the grouped list and
  finds the group whose representative is the just-started run; falls back to the
  run's own thread id, else null). The reply run is the newest for that agent →
  the group representative → selecting `logThreadId` shows its live output.
- The route (`app/routes/project.task.tsx`, `comment` intent) passes
  `logThreadId` back in the fetcher payload.
- `Timeline` gained an optional `onAgentLog(threadId)` callback, fired once on a
  successful comment submission that carries a `logThreadId`.
- `TaskDetailPage` wires `onAgentLog` → sets `logSel` to the agent's grouped id
  and `scrollIntoView`s the Agent-logs panel. A `pendingLogSel` effect keyed on
  `runtime` re-confirms the selection **after revalidation** lands the reply run
  in `runtime[]` (guards the race where the loader hasn't re-run yet). The
  existing `useRunLogStream` streams the live lines via `run.log-appended`.

---

## Files

| File | Change |
| --- | --- |
| `package.json` | +`react-markdown@^10.1.0`, +`remark-gfm@^4.0.1` |
| `app/ui/markdown.tsx` | **new** — `<Markdown>` GFM renderer (mono code, scrolling tables, safe links) |
| `app/features/task-detail/timeline.tsx` | comments render via `<Markdown>` in `.md-body`; typed events keep `RichText`; new `onAgentLog` prop |
| `app/app.css` | **new** `.md-body` scoped block in the app-additions section |
| `db/migrations/0010_run_agent_identity.sql` | **new** — `agent_name` + `agent_profile_id` on `agent_runs` |
| `app/server/runtimes/run-store.server.ts` | identity cols on `AgentRunRow`/`InsertRunInput`; `upsertRun` persists them |
| `app/server/runtimes/run-projection.server.ts` | per-agent grouping + representative selection; `who.name = agent_name ?? WHO_NAME` |
| `app/server/runtimes/run-service.server.ts` | `StartRunInput` identity fields; `startRun` persists; `resumeRun` carries; `scheduleOperatorRun` stamps Operator |
| `app/server/tasks/specialist-run.server.ts` | `startSpecialistRun` passes the specialist name + profile id |
| `app/server/tasks/task-actions.server.ts` | `commentToAgent` returns `logThreadId`; resume passes agent identity; `resolveReplyLogThread` helper |
| `app/routes/project.task.tsx` | `comment` intent returns `logThreadId` |
| `app/features/task-detail/task-detail-page.tsx` | `onAgentLog` → select + scroll; `pendingLogSel` effect confirms after revalidation |

### Tests (21 new; 1 existing updated)

| File | Change |
| --- | --- |
| `app/ui/markdown.test.tsx` | **new** (9) — table/lists/newlines/hard-break/code/emphasis/links/emoji/raw-HTML-safe |
| `app/server/runtimes/run-projection.server.test.ts` | **new** (5) — 3 dev runs + 1 op → 2 groups; representative = running-or-latest; null-identity fallback; distinct agents; legacy role grouping |
| `app/server/runtimes/run-service.server.test.ts` | +3 — `startRun` persists identity; `resumeRun` carries; `scheduleOperatorRun` stamps Operator |
| `app/server/tasks/agent-reply.server.test.ts` | +2 — `commentToAgent` returns `logThreadId` (resolves to the "dev" group); null when no agent |
| `app/features/runtime/runs-panels.test.tsx` | +2 — picker labels each agent by `who.name`; selecting an agent shows its lines |
| `app/features/task-detail/task-detail-components.test.tsx` | updated 1 — comment renders `.md-body`, `@mention` is plain text (documented decision) |

No migration-count test exists (the migration-runner test asserts on names/
tables, not a count), so nothing to bump there.

---

## Browser checks for the orchestrator (containerless / CTL-1, the `dev` agent)

1. **BUG 1 — markdown replies.** Comment `@dev` something that makes it reply
   with a list/table; the agent-authored reply comment should render real line
   breaks, a bulleted/numbered list, and a table (scrollable if wide), with
   emoji intact — not one run-on blob.
2. **BUG 2 — grouped, named dropdown.** With an operator + the primary `dev`
   (after several resumes) on a task, the **Agent logs** dropdown shows exactly
   **one entry per agent**, labeled **"dev"** / **"Operator"** (not "Claude
   Code"), each with role/sdk as the secondary line.
3. **BUG 3 — comment auto-selects + streams.** Commenting `@dev …` should
   auto-select **dev**'s log in the Agent-logs panel, scroll it into view, and
   stream its live output — no hunting.

---

## Deviations / notes

- **Mentions in comments render as plain text** (BUG 1 documented decision) —
  the `.mention` chip stays only on single-line typed events.
- **Comment-resume of a purely-seeded session** stamps the current profile
  name/id on the new run, so the reply run forms a *named* group. If the prior
  seeded run had null identity, that seeded row remains in its own
  `kind:role` group — an acceptable, demo-only edge; app-started runs already
  carry identity and group cleanly.
- Composer/packet bodies were left on their existing renderers (not the same
  component; out of scope per the brief).
