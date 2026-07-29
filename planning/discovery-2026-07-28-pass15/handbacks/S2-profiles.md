# S2-profiles → handbacks (pass 15)

Three small edits live in files S2 does not own. Each is one call site; the
server-side behavior and the copy are already implemented and tested in S2's
files.

## 1. B-AG2 — post the policy-note reply for an ambiguous `@claude`/`@codex`

**File:** `app/server/tasks/task-actions.server.ts` (`commentToAgent`, the
`if (!target) { … }` early return around :959).

`resolveMentionedAgent` now REFUSES a backend handle that covers more than one
deployed specialist (it used to engage the first-listed one). The comment still
posts; nobody is engaged; today that is silent. The note is built and tested in
`app/server/tasks/agent-reply.server.ts`:

```ts
const { ambiguousBackendHandle, ambiguousBackendHandleNote } = await import("./agent-reply.server");
// … inside the `if (!target)` branch, after the comment is appended:
const ambiguous = ambiguousBackendHandle(ctx, input.projectSlug, input.text);
if (ambiguous) {
  // append a system/policy timeline note with ambiguousBackendHandleNote(ambiguous)
  // — same writer the `directiveRequestsDelivery` policy event uses (:944-958).
}
```

`ambiguousBackendHandleNote` returns one sentence naming every candidate
(`@docs-writer (Docs Writer) · @security-reviewer (Security Reviewer)`) and
points at `@agent` for the primary. Proving tests for the refusal +
note: `app/server/tasks/agent-reply.server.test.ts` →
"refuses an AMBIGUOUS backend handle instead of engaging the first-listed profile".

## 2. R15-7 — completion-time gates for a ghost profile

**File:** `app/server/tasks/task-actions.server.ts` :2070-2084
(`applyAgentCompletionEffects`).

The RUN side is done (`specialist-run.server.ts` resolves collab from
`withheldAgentGrants()` when the profile can't be resolved). The completion side
still falls back to `grants = []`, which `resolveAgentCollab` reads as
comment/ask/evidence GRANTED — so a ghost profile's finished run can still open
a question packet and assert evidence. One line:

```ts
let grants: … = withheldAgentGrants();          // was: []
if (input.profileId) {
  try { grants = resolveDeployedSpecialist(ctx, …).capabilities; }
  catch { /* undeployed — the withheld posture above applies (R15-7) */ }
}
```

`withheldAgentGrants` is exported from `~/features/agents/capability-catalog`
(already imported by specialist-run for the same purpose). Suggested test: a
finished run whose deployment was removed mid-flight produces NO question packet
and no agent-asserted evidence rows.

## 3. B-AG1 — surface the delivery-grant notice in the save toast

**File:** `app/routes/project.agents.tsx` (`create-profile` / `update-profile`
action branches).

`createAgentProfile` / `updateAgentProfile` now return
`{ profileId, name, notice? }` where `notice` is a `DeliveryGrantNotice`
(`kind: "repaired" | "withheld"`, plus a ready-to-render `message`). The audit
row already carries `deliveryGrants` + `deliveryNote`; the toast still doesn't
mention it. Suggested:

```ts
toast: `Profile "${result.name}" created — available for future assignments` +
  (result.notice ? ` · ${result.notice.message}` : ""),
```

The `withheld` case is the one that matters: an admin who leaves
"Commit & push to the branch" granted while switching
"Execute code or write to the repo" to Off now KEEPS the Off (no more silent
escalation), so the profile cannot deliver and should be told so at save time.
