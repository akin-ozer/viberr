# Test and validation plan

Every item is validated three ways where it applies: by code (a real test through the
real writers or the route harness, no `vi.mock`), by a screenshot on `:5174`, and by
driving the browser. Canary rule from earlier passes: each new test is reverted against
the fix once to prove it fails without it.

## Server

| Area | Test file | What it proves |
|---|---|---|
| Conversation scope | `controller-conversations.server.test.ts` | task-bound create/list/filter; the CHECK refuses a task without a project; `taskKey` round-trips; `surface` stored on user rows only |
| Context read | `controller-context.server.test.ts` (new) | task scope: verbatim file inside the budget; over budget keeps head + newest entries and names the omitted count; head-only clip; board scope: counts, capped table, goals; instance scope: projects; surface hint; total under `CONTEXT_BLOCK_CHARS` |
| Turn prompt | `controller-run.server.test.ts` | the system prompt names the task binding; the turn prompt starts with the context block; `runControllerTurn` stores `surface` |
| Toolkit | `controller-toolkit.server.test.ts` | bound task defaults on every task tool; `update_task` refused for viewer, allowed per gate, full-replace metadata, goal length rule; `whoami.conversationTask`; the invariants test still passes (no delete, no always-human tool) |
| Shipped assets | `default-assets.server.test.ts` | outgoing hashes listed; the upgrade replaces the old doctrine and skill on boot; `list_projects` absent from both |
| Resource route | `resources.controller.test.ts` (new) | GET: instance view for any user; board view for a member; unknown slug and non-member answer the byte-identical 404; unknown task 404 copy; `c` outside the scope 404; POST send creates a task-bound conversation and runs a fake turn; CSRF failure returns `{ ok:false }` with 403, never a thrown Response |
| Page routes | `controller.tsx` / `project.controller.tsx` actions | CSRF mapping; the project page lists task threads |

## Client (jsdom)

| Area | Test file | What it proves |
|---|---|---|
| Context derivation | `controller-dock-context.test.ts` (pure) | every route id maps to the right scope; hidden on the controller pages and login; surface string |
| Dock component | `controller-dock.test.tsx` | renders the trigger with the scope in its name; opens, focuses the composer, Escape closes and restores focus; threads toggle; the context line per scope; the working dot; hidden trigger on mobile while open (class only) |
| Page | `controller-page.test.tsx` (new) | task chip in the list; project name in the header; surface chip on a user message |
| CSS gates | `app.css.test.ts` | the new section uses only locked steps, one declaration per breakpoint, and no control hidden under a width query — all by the sheet's existing no-allowlist gates. *(Corrected 2026-09-03: this claimed two dock-specific pins that were never written. The gates that hold the dock are the existing ones; the reduced-motion and bottom-sheet behaviour is pinned in `controller-dock.test.tsx` and the e2e spec instead.)* |

## Browser (Chromium via the pane, `:5174`)

1. Home: trigger visible bottom-right, name `Controller · Instance`; open; context line;
   send "what projects can I see" (needs the Claude credential; otherwise the honest
   unavailable note appears in the transcript). Screenshot light and dark.
2. Board `/projects/viberr/board`: trigger name `Controller · viberr`; open; the thread
   list is empty; send a message; the working dot; the reply lands with the entry
   motion. Screenshot.
3. Task `/projects/viberr/tasks/VIB-1`: name `Controller · VIB-1 · viberr`; context line
   names the task file; the run's prompt (read from the run log console) contains the
   `task.md` block. Screenshot.
4. Navigate task → board → task with the panel open: the thread follows the context and
   returns to the same conversation.
5. Escape closes and focus lands on the trigger; Close button animates; reload keeps the
   panel open.
6. `/controller` and `/projects/viberr/controller`: no trigger. The project page lists the
   task thread with a `VIB-1` chip and opens it with `?c=`.
7. 375 px viewport: bottom sheet, the trigger still on screen above it (R19-12), no
   horizontal scroll.
8. Stale CSRF: send with a wrong token from the console → error toast, page intact.

## e2e (Docker, `npm run e2e`)

`e2e/08-controller-dock.spec.ts`: the trigger exists on the board and the task with the
right names; opening focuses the composer; the panel is hidden on the controller page;
375 px sheet. Runs against the production image like every other spec.
