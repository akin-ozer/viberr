> Scope: triage-gate test coverage (pass 8).
The triage gate holds unscoped/underspecified tasks at Triage pending human
scoping input. It's covered by the `task-governance.server.test.ts` test
"leaving triage clears the input_required gate (readiness→ready)", which
asserts input_required readiness only clears once a human moves the task
out of Triage. Last reviewed: 2026-07-18
