# W2 (agent runtime) → lead: changes needed in files I do not own

Four requests. Each is a small edit in a file outside my ownership list; the
runtime-side support each one needs is already landed in my files.

---

## 1. RT-02 / LV-04 — thread the human's comment into a FIRST-EVER @mention run

**File:** `app/server/tasks/task-actions.server.ts` (`commentToAgent`, both fresh
branches, currently lines 1109-1114 and 1127-1132).

**Why:** neither fresh branch passes `directive`, so a first-ever @mention starts
a run that never receives the comment. Live (LV-04) the agent then read the TASK
GOAL as its instruction, classified it as a prompt-injection attempt and posted a
request-changes verdict on a task with no diff — and, having no asker to address,
tagged nobody, so nobody was notified (NEW-4).

**Runtime support already landed:** `startAgentRun` accepts `directive` and a new
`directiveFrom` (the asker's display name); `buildAnalyzePrompt` renders
`A human (<name>) asked you: "<text>"` plus `start your reply by tagging them —
"@<name>"`. Covered by
`app/server/tasks/specialist-run.server.test.ts` → "P14-RT-02: names the human who
asked and tells the agent to tag them back".

**Exact change** — `commenterName` is already in scope (assigned just above, line
~1023). Primary branch:

```ts
      const started = await startAgentRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          // P14-RT-02: a FRESH mention run gets the human's words + name, the
          // same way the resumed path gets `specialistReplyDirective`.
          directive: input.text.trim(),
          directiveFrom: commenterName,
        },
        actor,
        ctx,
      );
```

Reviewer branch (keep `profileId`):

```ts
      const started = await startAgentRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          profileId: target.profileId,
          directive: input.text.trim(),
          directiveFrom: commenterName,
        },
        actor,
        ctx,
      );
```

---

## 2. RT-12 — one @handle derivation

**File:** `app/server/tasks/task-actions.server.ts:1132` (the resumed branch's
`registerAgentCompletion` call), currently `agentHandle: target.name.toLowerCase()`.

**Why:** the handle was derived twice and differently — role-first-word in
`startAgentRun` (`"Senior Developer"` → `@senior`, which resolves to no agent at
all) and name-lowercased here (multi-word names → `@docs writer`, resolvable only
to a reader that already knows the name). The stuck packet's `Agent: @…`
observation could therefore name a handle nobody could reply to.

**Runtime support already landed:** `agentMentionHandle({ profileId, name })` in
`app/server/tasks/agent-reply.server.ts` (profile-id first, so the bare `@word`
grammar matches it; falls back to the name). `specialist-run.server.ts` and
`run-recovery.server.ts` already use it. Tested in
`app/server/tasks/agent-reply.server.test.ts` → describe "agentMentionHandle
(P14-RT-12)".

**Exact change** — `agentMentionHandle` is exported from the module
`commentToAgent` already imports at the top of the function (`resolveMentionedAgent,
resumeWorkdir` from `./agent-reply.server`): add it to that destructure and use

```ts
      agentHandle: agentMentionHandle({
        profileId: target.profileId,
        name: target.name,
      }),
```

---

## 3. RT-06 / KM-06 — the capability metadata now understates Codex

**File:** `app/shared/capabilities.ts`.

**Why:** `use-web-search-fetch` withheld is now REALLY enforced on Codex —
`codex-runtime.server.ts` sets `webSearchMode: "disabled"` for a specialist whose
grant is withheld (the same channel the operator already used), fed by
`webSearchWithheldFromDenylist` in `run-service.server.ts`. Both backends now
remove the built-in web tool and neither blocks `curl` through Bash, so the
enforcement is at parity. Two statements are false as they stand:

**(a) line ~66**, in the `cap("use-web-search-fetch", …)` docstring:

> `Enforced with tool denial on Claude; prompt-level on Codex, whose built-in web tools have no denylist channel.`

There is no such prompt text anywhere — the claim was invented, not merely stale.
Replace with:

```ts
  // profile. Enforced on BOTH backends: tool denial on Claude (WebFetch/
  // WebSearch removed), `webSearchMode: "disabled"` on Codex (P14-RT-06).
  // `curl`/`wget` through Bash stay reachable on both — the specialist needs
  // Bash for validation; that tension is documented, not papered over.
```

**(b) lines ~194-196** — remove `use-web-search-fetch` (and its two-line comment)
from `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, exactly as P14-RT-03 removed
`execute-code-or-write-repo`. It currently renders a matrix badge reading
"binds tools on Claude runs · advisory on Codex" for a capability that binds on
both.

---

## 4. RT-04 / KM-02 — the `OperatorAuthority.mcps` docstring is now out of date

**File:** `app/server/tasks/operator-actions.server.ts` (~line 84).

**Why:** the gap it describes ("never reached a run on EITHER backend") is closed
on both backends now — `startCodexOperatorRun` mounts
`resolveSpecialistMcpServers(db, authority.mcps)` (tested in
`app/server/runtimes/operator-run.server.test.ts` → "mounts the operator's declared
org MCP servers on the Codex run"). Suggested replacement for the docstring body:

```ts
  /**
   * The operator's declared org MCP servers. P13-KM-03 wired them into the
   * Claude toolkit; P14-RT-04 mounts them on the Codex operator too, so the
   * grant is real on both backends. On Codex the CLI translation drops
   * credentials (argv exposure) and stamps approve-mode, as for specialists.
   */
```

---

## 5. (minor) `specialist-tool-policy.ts` header claim

**File:** `app/server/tasks/specialist-tool-policy.ts:22`.

> `Codex runs use their own sandbox config and ignore this list.`

No longer wholly true: `run-service.server.ts` derives BOTH `repoWriteWithheld`
(P13-RT-02) and `webSearchWithheld` (P14-RT-06) from this list, and the Codex
adapter enforces them. Suggested: "Codex has no denylist channel, so the two
headline rules in this list are derived from it and enforced through the Codex
sandbox / `webSearchMode` instead (`repoWriteWithheldFromDenylist`,
`webSearchWithheldFromDenylist`)."
