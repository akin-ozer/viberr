# Owner question queue (asked 2026-09-02, with background and a recommendation each)

Each question changes what gets built. Everything not listed here was decided as a
routine judgment call and is written down in `DESIGN.md`.

## Q1. What shape is the helper?

**Background.** The ask says "helper hover icon across the app". Three shapes fit the
existing design language: (a) a floating bottom-right button opening a docked, non-modal
panel (the messenger pattern); (b) an icon in the topbar next to the bell opening a
popover (the bell/account pattern); (c) a full-height right drawer. The topbar exists only
inside the workspace and on Home, so (b) leaves Profile, Insights, Notifications and Org
settings without the helper unless the topbar is added there too. A drawer (c) pushes or
covers the page, which defeats "work beside it".

**Recommendation: (a).** One mount in `root.tsx`, visible on every signed-in surface,
non-modal, grows from its trigger. A bottom sheet on small screens.

## Q2. Which conversation does the dock open on?

**Background.** Threads are per context (instance, one board, one task). When the dock
opens on a task it can either reopen the most recent thread bound to that task, or always
start a fresh one and keep older threads behind the Threads toggle.

**Recommendation: reopen the most recent thread of the current context.** A helper you
come back to should remember what you were doing there; "New" is one click away.

## Q3. Should the controller be able to edit a task's goal and metadata?

**Background.** "If it's in tasks it … does the work" — today the toolkit can comment,
move (not into Done), own/assign, and run agents on a task, but it cannot edit the goal,
priority, labels or due date. The task page has both writers (`updateTaskGoal`,
`setTaskMetadata`) behind their own RBAC gates. Without a tool, a person on the task page
asking "make the goal say X" gets "edit it on the page" from a controller that is sitting
on that page. This is the same enforcement-parity class the owner has ruled in scope
before.

**Recommendation: add `update_task`** with exactly those four fields, through the same two
writers and gates the page uses. No title edit (no writer exists); no new gate.

## Q4. Should the transcript record where a message was sent from?

**Background.** The dock knows the page (`/projects/viberr/board?filter=waiting`) and the
design injects it into the turn prompt as a hint. It can also be stored on the user
message (`controller_messages.surface`) and rendered as a small chip on the full page, so
a transcript read back a week later still says the ask came from the board with the
"waiting on me" filter on. Costs one nullable column (pre-prod, no migration).

**Recommendation: store it.** Durable record, cheap, honest.

## Q5 (no answer needed unless you disagree). Defaults taken

- The dock is hidden on the two full controller pages and on `/login`.
- The trigger shows the working dot while a turn runs in the dock's conversation.
- Open/closed state and the per-context thread selection survive a reload (per tab).
- No keyboard shortcut, no ⌘K row.
- The panel does not close on an outside click (Escape or the Close button do).
- The full project Controller page lists task threads with a task chip.
