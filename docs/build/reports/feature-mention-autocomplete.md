# Feature — @-mention autocomplete in the task-comment composer

Typing `@` followed by at least one character in the task-detail comment
composer opens an autocomplete dropdown of matching **agents**, **reserved
handles**, and **users**. The typed substring is highlighted; selecting a row
inserts `@handle `. This is the input-side affordance for the mention routing
the server already performs when a comment is posted.

## Data sources

`app/server/tasks/mention-suggestions.server.ts` — `getMentionables(db,
projectSlug, taskKey, {dataRoot})` returns `{ agents, users, reserved }`.
It is a **new, read-only** loader helper (no store mutation), added to the
task loader in `app/routes/project.task.tsx` and threaded through
`TaskDetailPage → Timeline`.

- **agents** — `listDeployedSpecialists(db, projectSlug)` (the same source the
  "Assign specialist" menu uses). `handle = name.toLowerCase()` — exactly the
  value `agent-reply.server.ts` `handleMatchesSpecialist` matches on
  (name / id / backend). Carries `name`, `role`, `backend` for the glyph.
- **users** — `listUsers(db)` (every registered, non-disabled app user), with
  project members sorted first (membership order from `readProjectFile`), then
  the registered non-member tail. `handle = email local-part` — the primary key
  the server's mention fan-out resolves on (`task-actions.server.ts` resolves a
  handle against `email.split("@")[0]` OR the first name). Carries `name` +
  `email` for the Avatar/label.
- **reserved** — the four generic handles the routing regex honours
  (`task-actions.server.ts` `RESERVED_HANDLES` / `AGENT_HANDLE_RE`):
  `operator` (Operator), `agent` (Primary specialist), `claude`
  (Claude specialist), `codex` (Codex specialist).

## Alignment with server-side mention resolution

The dropdown never invents handles the server can't resolve:

| Group    | Composer handle            | Server resolves via |
| -------- | -------------------------- | ------------------- |
| agent    | specialist `name` (lower)  | `handleMatchesSpecialist` — name / id / backend |
| user     | email local-part (lower)   | fan-out — `email.split("@")[0]` or first name |
| reserved | `operator/agent/claude/codex` | `AGENT_HANDLE_RE` → primary specialist / backend |

So `@dev`, `@arda`, `@operator`, `@claude` chosen from the menu route the same
way they would if typed by hand.

## Token detection rules

`app/features/task-detail/mention-autocomplete.ts` — `detectMentionToken(text,
caret)` walks left from the caret over `[\w-]` characters. It returns a token
only when:

1. the run of `[\w-]` is immediately preceded by `@`,
2. the `@` is at start-of-string **or** preceded by whitespace (so an
   `a@b`-style email does not trigger), and
3. **at least one** `[\w-]` character follows the `@` (a bare `@` never opens).

The query is lowercased for case-insensitive matching. The composer recomputes
the token on `change` (via `requestAnimationFrame` so the caret is settled),
`keyUp`, `click`, and `select` — i.e. on every input and caret move.

## Filtering + highlight

- `flattenMentionables` flattens the three groups in precedence order:
  **agents → reserved → users**.
- `filterMentions(all, query, 8)` keeps rows whose handle **or** display name
  starts-with (rank 0) or includes (rank 1) the query, case-insensitive;
  sorted by rank then group order, capped at 8.
- `splitHighlight(label, query)` splits a label into `[before, match, after]`
  around the first case-insensitive occurrence. The menu wraps `match` in the
  shared `.mention` chip (`app.css`) — the same highlight style used to render
  posted mentions, so the affordance and the result look consistent. Both the
  display name and the muted `@handle` are highlighted.

## Keyboard model

Handled by `useMentionAutocomplete` (`use-mention-autocomplete.ts`), only while
the menu is open:

- **ArrowDown / ArrowUp** — move the active row (wrapping); the active row
  renders with `.on` and drives `aria-activedescendant`.
- **Enter / Tab** — insert the active suggestion (`@handle `, trailing space)
  replacing the active token, then close.
- **Escape** — close without inserting (draft unchanged).
- **⌘/Ctrl+Enter** — never intercepted; always falls through to the composer's
  send, open or closed. Plain Enter only selects a suggestion **while the menu
  is open**; with the menu closed the textarea behaves exactly as before.

Click inserts too; option rows `preventDefault` on `mousedown` so the textarea
keeps focus, and the caret is restored after the controlled re-render.

## Accessibility

The textarea is a `role="combobox"` with `aria-autocomplete="list"`,
`aria-expanded`, `aria-controls` (only while open, pointing at the rendered
listbox), and `aria-activedescendant` on the active option. The dropdown is a
`role="listbox"` of `role="option"` rows with `aria-selected` — mirroring the
existing run-selector menu (`runs-panels.tsx`), and reusing its `.rsel-menu` /
`.rsel-item` classes plus `AgentGlyph` / `Avatar` from `app/ui`. No new CSS
classes, no Tailwind, no inline hex — positioning uses inline tokens/units only.

## Files

- `app/server/tasks/mention-suggestions.server.ts` (new) + test
- `app/features/task-detail/mention-autocomplete.ts` (new, pure logic) + test
- `app/features/task-detail/mention-menu.tsx` (new dropdown component)
- `app/features/task-detail/use-mention-autocomplete.ts` (new hook)
- `app/features/task-detail/mention-composer.test.tsx` (new jsdom test)
- `app/features/task-detail/timeline.tsx` (composer wiring)
- `app/features/task-detail/task-detail-page.tsx` (prop pass-through)
- `app/routes/project.task.tsx` (loader `mentionables` + prop; loader-only edit)

## Verify

1. `npm run typecheck` — clean for these files (pre-existing `app/features/
   agents/**` `effort` errors belong to a concurrent unrelated change).
2. `npm test` — 27 new tests pass; the only failures are 3 in
   `app/features/agents/**` (the concurrent model/effort/catalog work).
3. `npm run build` — clean.
4. In the app: open a task (e.g. CTL-1), focus the comment composer, type
   `@de` → a dropdown lists **dev** with **de** highlighted → ArrowDown/Enter
   or click inserts `@dev `.
