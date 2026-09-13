# Owner decisions taken during pass 37

## D37-1 — A dependency hold is a HARD GATE, one spelling (2026-09-13)

*Context.* F37-2: `blockedBy` held nothing. Viberr wrote "Held until every entry is done;
Viberr releases it then" and 1.9 s later started a Codex run that designed and committed the
whole identity service onto a pushed branch cut from a `main` predating its dependency.

*Ruling.* A held task refuses **every** agent dispatch, at the same chokepoint and in the
same shape as the archived/terminal gate (ruling 177). No supporting-run carve-out, no
advisory mode. The words on the board become true.

*Accepted cost.* A held task can do no preparatory work at all — no reading, no drafting —
until its dependencies are satisfied and viberr releases it.

*Implementation note.* One gate in `startAgentRun`, beside the existing closure gate, with a
refusal sentence that names the unsatisfied entries; every door that dispatches goes through
it. The operator must not be woken to burn a paid turn restating the hold.

## D37-2 — MCP coverage uses a credential-free server (2026-09-13)

*Context.* The controller refused to provision an MCP server because every useful one needed
a token it may not accept in chat (correct behaviour — ruling: secrets never travel through
the controller conversation).

*Ruling.* Add a local, credential-free MCP server in Org settings, then have the controller
grant it to a profile. This exercises create → mark write tools (ruling 176) → grant → mount
→ enforce without a secret. The sealed-credential path is out of scope for this pass.
