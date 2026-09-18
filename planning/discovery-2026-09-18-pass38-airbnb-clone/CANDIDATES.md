# Pass 38 — candidates, with what was measured and what killed the dead ones

Every candidate gets: the observation, the measurement of how often it has ALREADY been
wrong on the live board, the refutation attempt, and a verdict. Confirmed ones move to
FINDINGS.md with a number.

| # | observation | measured | verdict |
|---|---|---|---|
| C1 | The controller's first two `ToolSearch` calls of a session use bare names (`select:whoami,…`) and get "No matching deferred tools found"; it then retries with the `mcp__viberr_controller__` prefix. | 8 of 40 controller runs that used ToolSearch hit the miss (14 lines); 2 of 12 reviewer runs. Cost: 2 wasted turns, ~3 s each, per affected run. | **confirmed → F38-1 (ruling 347)**: the manifest itself said `select:<name>` and listed bare names. |
| C2 | The Live-run header shows "Working · `<last tool call>`" for as long as the model THINKS after that tool answered (list_mcp_servers answered 02:02:38; header still named it at 02:03:20 while the console logged thinking lines). | 76 stretches > 20 s on 26 of the last 40 controller turns, 53 min in all, longest 138 s. | **confirmed → F38-2 (ruling 348)**. |
| L2-C1 | Lens-2: a queued run reads "agent working" on the board/hero/rail while the console says queued. | 129 queued-run timeline events on 33 tasks. | **confirmed → F38-3 (ruling 349)**. |
