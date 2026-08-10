# G19-h · Ruling 33 (R15-14) — a resolved question resumes the ASKING agent (live runbook)

**Proves:** ruling 33 — a resolved agent question goes back to the agent that ASKED it, by resuming
its own session (`askedBy` = profile id); operator hand-off is the fallback so no decision is
swallowed. Unit-pinned by `agent-toolkit.server.test.ts` + `agent-reply.server.test.ts`.

**Preconditions:** a task where a specialist (not the operator) raised an `ask_human` question — the
packet records `askedBy: <profileId>`.
**Steps:**
1. On the task with the open question packet, resolve it via the packet options (or reply to the
   @-mention the agent addressed to you).
2. Watch the timeline.
**PASS:** the SAME agent profile that asked is re-engaged (its session resumed) to consume the
answer — not a fresh operator turn that swallows it; if that agent can't resume, the operator picks
it up (fallback), never nobody. **FAIL → finding:** the answer lands nowhere, or a different agent
consumes it. **Cleanup:** none.
