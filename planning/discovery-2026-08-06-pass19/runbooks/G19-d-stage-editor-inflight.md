# G19-d · FR6 — edit the stage list while tasks are in flight (live runbook)

**Proves:** FR6 (admins define stages/transitions) stays safe when tasks already occupy stages.
Unit-pinned by `operator-run.server.test.ts` + `acceptance-graph.server.test.ts` (transition-chain
re-wire; the new hop inherits the boundary it replaced).

**Preconditions:** Viberr Core has tasks spread across stages (VC-2 Triage, VC-7 In Progress, etc.).
**Steps:**
1. Settings → Workflow stages. Add a stage between In Progress and Review (e.g. "QA") via **Add stage**,
   or drag to reorder; the re-wire copy explains the chain inherits the replaced boundary.
2. Re-open the board and a task that sat adjacent to the edit.
**PASS:** existing tasks keep their stage; the transition graph re-wires around the change (the new
hop's boundary = the one it replaced); Policy → Workflow rules reflects the new edge; no task is
stranded on a now-missing stage. **FAIL → finding:** a task points at a deleted stage, or a boundary
silently flips. **Cleanup:** remove the added stage (its tasks, if any, fall back per the chain).
