# W2 (agent runtime) → lead: changes needed in files I do not own

Status at hand-back time: **items 1, 2, 4 and 5 were already applied by the lead**
(commit `71aa7a9`) while this stream was running — they are recorded here for the
audit trail and verified against the current tree. **Item 3 is applied but
half-finished**; one line remains.

---

## 1. RT-02 / LV-04 — thread the human's comment into a FIRST-EVER @mention run — APPLIED ✅

`app/server/tasks/task-actions.server.ts` (`commentToAgent`, both fresh branches,
now lines 1109-1124 and 1137-1148) passes `directive: input.text.trim()` +
`directiveFrom: commenterName`. Verified present.

Runtime support in my files: `startAgentRun` accepts `directive` +
`directiveFrom`; `buildAnalyzePrompt` renders `A human (<name>) asked you: "<text>"`
and `start your reply by tagging them — "@<name>"`. Covered by
`app/server/tasks/specialist-run.server.test.ts` → "P14-RT-02: names the human who
asked and tells the agent to tag them back".

## 2. RT-12 — one @handle derivation — APPLIED ✅

`task-actions.server.ts:1180` now calls
`agentMentionHandle({ profileId: target.profileId, name: target.name })`, imported
from `./agent-reply.server` at :923. Verified present.

`agentMentionHandle` (profile-id first, so the bare `@word` grammar matches it;
display-name fallback) lives in `app/server/tasks/agent-reply.server.ts` and is
used by `specialist-run.server.ts` and `run-recovery.server.ts` as well. Tested in
`agent-reply.server.test.ts` → describe "agentMentionHandle (P14-RT-12)".

## 4. RT-04 / KM-02 — `OperatorAuthority.mcps` docstring — APPLIED ✅

`app/server/tasks/operator-actions.server.ts:85-93` now says the grant is real on
both backends. Matches the code: `startCodexOperatorRun` mounts
`resolveSpecialistMcpServers(db, authority.mcps)` (tested in
`operator-run.server.test.ts` → "mounts the operator's declared org MCP servers on
the Codex run").

## 5. `specialist-tool-policy.ts` header claim — APPLIED ✅

Lines 22-25 now name both derivations (`repoWriteWithheldFromDenylist`,
`webSearchWithheldFromDenylist`) instead of claiming Codex ignores the list.

---

## 3. RT-06 / KM-06 — capability metadata — ONE LINE STILL MISSING ⚠️

**Applied:** the `cap("use-web-search-fetch", …)` docstring no longer claims a
non-existent "prompt-level on Codex" fallback, and the id was removed from
`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`. Both correct — `codex-runtime.server.ts`
now sets `webSearchMode: "disabled"` for a specialist whose grant is withheld, fed
by `webSearchWithheldFromDenylist` in `run-service.server.ts`, so the two backends
are at parity (each removes the built-in web tool; neither blocks `curl`).

**Still needed** — `app/shared/capabilities.ts`: the id was removed from the
Claude-only set but never added to `ENFORCED_CAPABILITY_IDS`, so
`capabilityEnforcement("use-web-search-fetch")` now returns **`"advisory"`** —
i.e. "withholding this constrains nothing", which understates it further than the
"claude-only" it used to return. Add it to `ENFORCED_CAPABILITY_IDS` (line ~181),
next to the other both-backend collaboration gates:

```ts
  // P14-RT-06: withheld web egress binds on BOTH backends — WebFetch/WebSearch
  // denied on Claude, `webSearchMode: "disabled"` on Codex.
  "use-web-search-fetch",
```

Only the matrix badge consumes `capabilityEnforcement` today (the `"claude-only"`
branch), so this is a correctness fix to the shared contract rather than a visible
regression. `app/shared/capabilities.test.ts` (also not mine) is where the
assertion belongs — the "enforced on both" list at :56.
