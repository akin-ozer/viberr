# S3-operator handback — B-OP5 (`operatorBackendFor` duplication)

**Item**: B-OP5 (LOW) — collapse the duplicated deployment-backend resolution.

**Why handed back**: the whole duplication lives in `app/server/tasks/operator-actions.server.ts`,
which is outside this stream's file ownership. No part of it touches
`operator-run.server.ts`.

**The duplication** (`app/server/tasks/operator-actions.server.ts`):

- `operatorBackendFor` (~:135-151) resolves the deployed operator profile and picks its backend:
  ```ts
  return view.backends.find((b) => b === "claude" || b === "codex") === "codex"
    ? "codex"
    : "claude";
  ```
- `resolveOperatorAuthority` (~:190-196) computes `deploymentBackend` with the **same expression**
  over the same `effectiveProfileView(deployment)`.

Both also repeat the "find the agent whose `effectiveProfileView(...).kind === 'operator'`"
lookup, and both fall back to `"claude"` when nothing is deployed.

**Suggested collapse** (one helper, two callers):

```ts
/** The deployed operator profile view for a project, or null. */
function operatorDeploymentView(ctx, projectSlug) { … }

/** The backend a deployment runs on — the ONE place the fallback order lives. */
function backendOfView(view): RealBackend {
  return view.backends.find((b) => b === "claude" || b === "codex") === "codex"
    ? "codex"
    : "claude";
}
```

`operatorBackendFor` becomes `view ? backendOfView(view) : "claude"` (keeping its
try/catch, which exists because the UI calls it on a possibly-missing project);
`resolveOperatorAuthority` uses `backendOfView(view)` for `deploymentBackend`.

**Proving test** (colocated `operator-actions.server.test.ts`): deploy an operator whose
`backends: ["codex", "claude"]`, then assert `operatorBackendFor(...)` equals
`resolveOperatorAuthority(...).backend` — and again with `["claude", "codex"]`. That
test ties the two resolvers together so a future change to the picking rule cannot
land in only one of them (which is the whole point of the item).
