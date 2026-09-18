# Pass 38 — findings

Viberr builds an Airbnb clone in `akin-ozer/airbnb-clone` through its own controller.
Each finding: what was observed live, how often it had ALREADY been wrong on this
instance before it was believed, the refutation attempt, the fix, and the red-proof
(the test was made to fail by breaking the source, then restored).

Candidates that died, and what killed them, are in `CANDIDATES.md`.

## F38-1 — The tool manifest told the controller a `select:` shape its own names cannot satisfy (LOW; ruling 347)

**Observed** 2026-09-18 02:02:30Z, the first turn of the new conversation: the controller's
first two ToolSearch calls were `select:whoami,list_capabilities,…` and
`select:instance_health,list_mcp_servers,…`, both answered "No matching deferred tools
found"; the third guessed `select:mcp__viberr_controller__whoami,…` and worked.

**Why it did that.** Ruling 297's manifest (`tool-manifest.server.ts`) lists `- ${t.name}: …`
— the bare registry name — and says the description is "one ToolSearch away
(`select:<name>`)". The SDK mounts a server tool as `mcp__<server>__<name>`, and ToolSearch
answers to nothing else. Followed literally, the instruction fails every time.

**Measured** over `run_log_lines` before the fix: 40 controller runs used ToolSearch, **8 of
them wasted their opening calls on the bare-name miss (14 misses)**; 2 of 12 reviewer runs
too. The other runs learned the prefix from the per-turn deferred-name reminder, which is
the incremental list ruling 297 was written to replace.

**Refutation tried.** Is the miss caused by something else — a tool genuinely absent? No:
every missed name was on the manifest, and the same names succeeded one turn later with
the prefix. Is the cost real? Two turns and ~3 s per affected run; nothing lost, nothing
false is said to a person. So LOW, and fixed because the fix is one line and the
instruction was viberr's own, not the model's guess.

**Fix.** The manifest lists the mounted name (`mcp__viberr_controller__whoami`) and the
hint says `select:` takes the full name exactly as listed. `mountedToolName` is exported
so the toolkit's allow-list and the manifest cannot spell the prefix differently.

**Red-proof.** `tool-manifest.server.test.ts`: with the line restored to `${t.name}`, three
tests fail (the new one and the two that read a line by its name); restored, five pass.
