# Areas to improve, found while inspecting (2026-09-02)

Kept separately from the design so nothing here silently widens it. Each row says whether
this pass fixes it.

| # | Where | What | This pass |
|---|---|---|---|
| N1 | `controller.definition.md`, `controller-guide.skill.md` | The doctrine and skill tell the model to call `list_projects`, a tool that does not exist (docs §9 records it). The model wastes a turn or asserts it cannot list projects. | **Fixed**: `whoami` named instead; shipped through the hash upgrade. |
| N2 | `controller.definition.md` | Says a `comment_on_task` mention "can start that agent's run"; the tool only notifies humans and its description says so. | **Fixed** in the same edit. |
| N3 | `routes/controller.tsx`, `routes/project.controller.tsx` | Both actions use `requireFormAction`, whose CSRF check throws a raw 403 Response. From a fetcher that renders the ROOT error page (the `notifications/read` fix, UI-32, was never applied here). A stale tab loses the whole page on Send. | **Fixed**: `csrfError` mapping in both actions and in the new resource route. |
| N4 | `controller-page.tsx` header | "Managing the viberr board" prints the slug; every other surface names the project by name. | **Fixed** (the surface view carries `projectName`). |
| N5 | `controller-page.tsx` composer | No focus on open; on a page whose only purpose is typing. | **Fixed** (autofocus on the page and the dock). |
| N6 | Insights | Controller runs are labelled `controller (instance)` even when the conversation is board- or task-bound. | Not fixed: the run row carries no binding and the label reads from the run. Noted for a later pass. |
| N7 | `controller_messages` | A notification kind comment in the schema describes a "conversation reply" notification never created (docs §9). | Not fixed (documentation drift only). |
| N8 | Controller page | The transcript is a fixed-height scroll box (`max-height: calc(100dvh - 320px)`) that does not grow with the viewport on tall screens. | Not fixed; cosmetic. |
| N9 | `use-live-updates.ts` | Every surface opens its own EventSource; the dock adds a second one while open on the two stream-less pages. Acceptable, but a single app-wide stream owned by root would let every surface share it. | Not fixed; recorded as a future simplification. |
| N10 | Toolkit `get_task` | Returns the projection summary plus events but never the goal text or the packet body; on the task page the dock's context read covers it, but the instance-scoped controller still cannot read a task's goal without the file. | Partly covered: the task-scope context read includes the file. `get_task` itself is unchanged. |
| N11 | Org settings → Controller tab | "Open the controller" always goes to `/controller`; fine, but the tab could also say the dock exists. | **Fixed**: one sentence added to the tab lead. |

## Adversarial review, 2026-09-03 (the round the fixes came from)

Eight lensed reviewers read the change set; every finding was put to three independent
skeptics (reproduce / by-design / severity-and-scope) and kept only when two of three
could not refute it; a synthesis merged duplicates and a completeness critic hunted what
the eight lenses never looked at. 36 findings confirmed, all fixed in the same change.
The critic's own highest finding is the one no reviewer reached: an existing data root
had no additive backstop for the two new columns, so the first signed-in page would have
500'd and shown the root error page everywhere (`ensureBaselineColumns`, `sqlite.server.ts`).

Left open on purpose, and why:

| # | What | Why it is not fixed here |
|---|---|---|
| N12 | Controller transcripts have no retention: `retention.server.ts` ages out run-log lines, audit events and notifications, nothing ages out `controller_conversations` / `controller_messages`. The dock puts a composer on every surface and prepends up to 32 000 chars of context to every turn prompt, so both tables and the run log now grow faster. | Pre-existing since ruling 99, and the choice is the owner's: a per-user count/age window, or a recorded decision that transcripts are kept forever. Needs a ruling, not a patch. |
| N13 | `/insights` labels every controller run `controller (instance)`, including board- and task-bound turns. | The run row carries no binding (`project_slug` is deliberately `''` so no task query matches it); giving Insights the scope means either a new column or a join through the conversation. Worth a pass, not a review fix. |
| N14 | The context read is unmeasured on a very large board or a multi-megabyte `task.md`: `readTaskFile` reads the whole file before `clipTaskFile` discards most of it. | The two hot re-reads the review found (a second full board load, 40 project-file parses per instance turn) are fixed; this one needs a fixture nobody has yet. |
