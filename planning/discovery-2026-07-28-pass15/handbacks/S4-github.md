# S4-github handbacks

Three items in my ledger need edits in files outside my ownership set. Each
patch below is small, additive, and independent of the rest of my stream — my
own side of each is already landed and tested.

---

## 1. F15-01(a) — prove the credential at PROJECT CREATION

**File (not mine):** `app/features/home/project-create.server.ts`

**Why:** `createProject` binds the connection's PAT (`setProjectCredential`,
~line 308) and stops there. Attach/rotate (`runSetCredential`) has always
followed the bind with a repo-scoped revalidation so a fine-grained token's
chips upgrade from `assumed` to dry-run-probe verdicts — creation never did.
That is exactly why the live repro showed a credential card with ZERO proven
scopes on a brand-new project.

**My side (landed):** the revalidation is now an exported helper so both paths
prove the credential identically —
`proveAttachedCredential(db, projectSlug, actor, ctx)` in
`app/features/github/github-actions.server.ts` (best-effort by contract: it
swallows a degraded GitHub, the bind has already happened).

**Patch:**

```ts
// with the other imports
import { proveAttachedCredential } from "~/features/github/github-actions.server";

// …immediately after the existing bind:
  setProjectCredential(db, { projectSlug: slug, patId: connection.patId }, actor);
+ // F15-01: creation is the first moment this PAT meets the project's real
+ // repository — prove the scopes here, exactly as attach/rotate does, or the
+ // credential card affirms nothing it can back up.
+ await proveAttachedCredential(db, slug, actor, { dataRoot: ctx.dataRoot });
```

`createProject` is already `async`. `ctx` would need a `fetchImpl?: typeof fetch`
passthrough for a test to inject the transport (the existing
`probeRemoteRepo(token, repo)` call has the same gap, so this is one hook for
both).

**Proving test (to add in `project-create.server.test.ts`):** create a
connection with a fine-grained token, create a project, then assert
`getProjectCredential(db, slug)!.validation!.repo === "<owner>/<name>"` and that
the `repo` scope chip is `source: "probe"` — on main it is `assumed`/absent.

---

## 2. B-GH8 — `revalidateProjectCredential` must not clear a WRITE violation on read-only evidence

**File (not mine):** `app/server/secrets/pat-validator.server.ts` (~508-523)

**Why:** the violation sweep resolves every open violation whose scope the fresh
run reports `ok` — including `ok: true, source: "assumed"`. For a fine-grained
token whose dry-run write probe was skipped (`pullsReadOk !== true`, or the
contents probe unreachable), "Grant scope" therefore clears a real
`pull_request:write` violation on evidence that proved only READ. The violation
reopens only at the next live 403 — i.e. at the next failed delivery.

**Patch (inside the sweep loop):**

```ts
+ // B-GH8: a WRITE scope may only be cleared by WRITE evidence. `assumed`
+ // means the dry-run probe never answered — resolving on it turns "we don't
+ // know" into "granted", and the human learns otherwise at the next failed
+ // delivery. Read-only scopes keep the historical assumed-ok behaviour.
+ const WRITE_SCOPES = new Set(["repo", "pull_request:write"]);
+ const provenScopes = new Set(
+   validation.scopes.flatMap((s) =>
+     s.ok && (s.source === "header" || s.source === "probe") ? [s.id] : [],
+   ),
+ );
  for (const violation of listScopeViolations(db, projectSlug, { status: "open" })) {
-   if (!grantedScopes.has(violation.scope)) continue;
+   const enough = WRITE_SCOPES.has(violation.scope)
+     ? provenScopes.has(violation.scope)
+     : grantedScopes.has(violation.scope);
+   if (!enough) continue;
```

Also worth updating the function's doc comment, which currently states the
`assumed`-resolves-it behaviour as deliberate.

**Proving test:** open a `pull_request:write` violation, revalidate with a
fine-grained transport where `GET /repos/{r}/pulls` succeeds but the
`POST /repos/{r}/pulls` dry-run answers 500 (unknown → `assumed`), and assert
the violation is STILL open. Fails on main (it resolves).

---

## 3. F15-03 — watcher logs "reconciled removed directory" for a just-CREATED project dir

**File (not mine):** `app/server/files/file-watch.service.server.ts` (~145-196)

**Verdict: benign — no state-loss path. It is a false log plus wasted work.**

Traced it end to end:

- `fs.watch` emits `rename` for directory CREATION as well as removal, and
  `onChange` schedules `rebuildDir` for *every* `rename`
  (file-watch.service.server.ts:209). `rebuildDir` never checks whether the
  directory still exists, so `projects/<slug>` appearing runs the
  `reconcileProject(slug)` branch and logs `watcher reconciled removed
  directory` (:163).
- No state is lost. The 250 ms debounce (`WATCH_DEBOUNCE_MS`) fires well after
  `createProject` has written `project.md` and run its own `rebuildPath`, so the
  reconcile is an idempotent upsert; the task sweep it then runs finds an empty
  `task_projections` set for a new project. Task files are written through
  `writeFileAtomic` (temp + rename), so a task.md is never transiently absent
  once created either.
- The cost is real but small: every directory creation under `projects/`
  (including `projects/<slug>/tasks`, segments.length === 2) re-reads and
  reprojects every task of that project.

**Suggested patch** (log truth + skip the sweep for a creation):

```ts
  const rebuildDir = (absDir: string) => {
    try {
      const db = resolveDb();
      const rel = path.relative(watchedDir, absDir);
      if (rel.startsWith("..")) return;
+     // `rename` fires for directory CREATION too. A directory that is still
+     // there was not removed: the file-level handlers already project its
+     // contents, and the removal sweep below would only re-read them.
+     if (existsSync(absDir)) return;
      const segments = rel === "" ? [] : rel.split(path.sep);
```

(with `import { existsSync } from "node:fs";`). A genuine removal is unaffected;
a rename-IN (restore) still reconciles, because the *old* path is gone and its
own event carries the sweep.

**Proving test:** create a project directory under a watched root and assert the
`reconciled removed directory` log/reconcile never fires for it — or, cheaper,
call the exported handler with an existing directory and assert no task rows are
re-read.

---

## Note for whoever owns `app/server/org/store-files.server.ts`

B-GH7 landed as `ensureConnectionFresh` / `getDefaultConnectionTokenFresh` in
`app/server/org/connections.server.ts`, and is wired into `runSetCredential`.
The other consumer of a connection token — the StoreBrowser GitHub import at
`store-files.server.ts:579` — still calls the SYNC `getDefaultConnectionToken`,
so it can still hand out a token whose `valid` verdict is months old. It is
already inside an async function, so the upgrade is one line:

```ts
- const tokenInfo = getDefaultConnectionToken(db);
+ const tokenInfo = await getDefaultConnectionTokenFresh(db, {
+   ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
+ });
```

The existing `no_connection` branch already carries the right copy for the
downgraded case.
