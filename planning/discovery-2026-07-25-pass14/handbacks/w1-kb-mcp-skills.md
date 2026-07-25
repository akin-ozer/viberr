# W1 handbacks — knowledge bases, MCP servers, skills

Changes W1 needs in files outside its ownership. Each item is exact: file,
where, what, why. Everything else for the listed findings is already implemented
and tested on the branch.

---

## H1 — `app/routes/org.settings.tsx` (REQUIRED for KM-08 / UI-59 / UI-61)

The in-app KB editor cluster (owner ruling R14-4) is fully implemented in
`app/features/kb-browser/store-browser.tsx` + `app/server/org/store-files.server.ts`.
Three route intents have to carry the new fields, otherwise the client posts
them and the action drops them.

**Failure mode if not applied:** open-an-existing-doc silently returns "Unknown
action" (the editor shows the error inline and keeps the draft — no data loss),
a confirmed overwrite is refused by the server with `… already exists`, and the
GitHub import keeps landing at the store root. Nothing regresses to *silent*
data loss, but three shipped affordances stay broken.

### H1.1 `store-write-doc` — forward the replace intent

```ts
      case "store-write-doc": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = writeStoreDoc(
          db,
          target,
          parseJsonStringArray(field("path")),
          field("name"),
          field("body"),
          actor,
          // P14-UI-59: writing was create-OR-overwrite with one "saved" toast,
          // so retyping an existing name destroyed the file. The server refuses
          // a collision unless the UI's replace confirm says otherwise.
          { overwrite: field("overwrite") === "1" },
        );
        return ok(
          `${result.path.join("/")} ${result.replaced ? "replaced" : "saved"} — ${result.bytes} bytes`,
        );
      }
```

### H1.2 `store-read-doc` — NEW intent (this is what makes `readStoreDoc` live)

Add next to `store-write-doc`, and add `readStoreDoc` to the existing
`~/server/org/store-files.server` import:

```ts
      // P14-KM-08/UI-61: `readStoreDoc` shipped in pass 13 with no production
      // caller at all, so an existing document could not be opened or edited —
      // the only in-app edit was a blind overwrite by retyping its name.
      case "store-read-doc": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const doc = readStoreDoc(target, parseJsonStringArray(field("path")));
        if (!doc) return fail("That file no longer exists.", 404);
        return ok(undefined, { text: doc.text, truncated: doc.truncated });
      }
```

`readStoreDoc` now throws `AppError.validation` for a non-text extension (a PDF
is refused by TYPE, not reported as missing); `appErrorResponse` in the existing
catch renders that correctly.

### H1.3 `store-import-github` — forward the browsed folder

```ts
      case "store-import-github": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = await importGithubSnapshot(db, target, field("url"), actor, {
          // P14-KM-08: the import ignored the browsed folder and always wrote to
          // the store root, so imports could not be organised from the UI.
          dirPath: parseJsonStringArray(field("path")),
        });
        if (result.status !== "imported") return fail(result.message);
        return ok(result.toast, { folder: result.folder });
      }
```

`result.folder` is now the store-RELATIVE destination (`vendor/docs`, not
`docs`); the client expands every ancestor of it.

---

## H2 — KB budget: stop skipping the later KBs (KM-05)

`readKbBody` now returns a visible `_(knowledge base omitted entirely — N docs
dropped …)_` marker plus a `logger.warn` when the remaining budget fits nothing
(it used to suppress both in exactly that branch). The two callers still `break`
before calling it, so a later KB is still dropped with zero signal. Delete the
break in both:

**`app/server/tasks/specialist-run.server.ts:1000-1008`** (in `buildSpecialistPersona`)
and **`app/server/runtimes/operator-run.server.ts:1168-1176`** (in
`buildOperatorSystemPrompt`) — identical shape in both:

```ts
  let kbBudget = KB_INJECTION_BUDGET;
  for (const name of input.kb ?? []) {
    // P14-KM-05: do NOT skip once the budget is spent. `readKbBody` returns an
    // explicit "omitted entirely" marker for a KB that no longer fits, so the
    // prompt names the KBs that were dropped instead of quietly shrinking.
    const body = readKbBody(name, input.dataRoot, Math.max(0, kbBudget));
    if (body) {
      resourceParts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
      kbBudget -= body.length;
    }
  }
```

(the operator copy uses `authority.kb`, `dataRoot` and `parts` instead of
`input.kb`, `input.dataRoot` and `resourceParts`.)

Covered by `app/server/files/kb-injection.server.test.ts` —
"a KB that fits NOTHING still says so instead of vanishing" and "an exhausted
budget (0 chars left) is reported".

---

## H3 — record unresolvable MCP grants (LV-09)

`app/server/tasks/specialist-mcp.server.ts` now exports
`resolveSpecialistMcpServersDetailed(db, names) → { servers, unresolved:
{ name, reason }[] }`. `resolveSpecialistMcpServers` is unchanged for existing
callers. The diagnostic currently reaches nothing but the log — LV-09 asks for
a surface a human can see.

### H3.1 `app/server/tasks/specialist-run.server.ts:184-191`

```ts
/** Resolve declared MCP names to the portable runtime MCP shape, or `{}`. */
function mcpServersFor(
  db: DatabaseSync,
  names: string[],
): { mcpServers?: Record<string, unknown>; unresolved: string[] } {
  const { servers, unresolved } = resolveSpecialistMcpServersDetailed(db, names);
  return {
    ...(Object.keys(servers).length ? { mcpServers: servers } : {}),
    unresolved: unresolved.map((u) => u.name),
  };
}
```

### H3.2 the persona must not advertise a server that isn't mounted

`specialist-run.server.ts:680-687` passes `mcps: mcpNames` — the DECLARED names.
That is the literal LV-09 symptom: the prompt announced `vm-memory` while the
run exposed zero tools from it. Resolve first, then build the persona from what
actually mounted, and name what did not:

```ts
  const declaredMcps = mcpServersFor(db, mcpNames);           // move ABOVE the persona
  const mountedMcps = Object.keys(declaredMcps.mcpServers ?? {});
  const persona = buildSpecialistPersona({
    profileId: engagement.profileId,
    skills,
    kb,
    mcps: mountedMcps,
    unresolvedMcps: declaredMcps.unresolved,
    ...
  });
```

and in `buildSpecialistPersona` (`:967`), after the MCP-governance rule:

```ts
  // P14-LV-09: a granted MCP that resolves to nothing used to be announced in
  // the prompt and mounted nowhere — silent capability loss. Say so, so the
  // agent reports the gap instead of claiming a tool it never had.
  if ((input.unresolvedMcps ?? []).length > 0) {
    parts.push(
      "\n\n---\n# Unavailable MCP servers\n\n" +
        `Your profile grants ${input.unresolvedMcps!.join(", ")}, but ${input.unresolvedMcps!.length === 1 ? "it is" : "they are"} NOT mounted on this run (no such server in the org registry). Do not claim or attempt tools from ${input.unresolvedMcps!.length === 1 ? "it" : "them"} — report the gap instead.`,
    );
  }
```

Same treatment on the resume path (`resolveResumeConfinement`, `:1239` + the
persona at `:1266`).

### H3.3 `app/server/tasks/operator-toolkit.server.ts:368`

Switch to the detailed resolver and push `unresolved` into whatever run
evidence the operator records (or, minimally, keep the existing warn — the
persona-side fix above is the surface that matters).

---

## H4 — `app/server/tasks/operator-toolkit.server.ts` comment (KM-12)

Two comments claim `allowedTools` confines the run. Operator runs use
`bypassPermissions`, under which the adapter documents `allowedTools` as
auto-approve-only ("does NOT remove tools from context",
`claude-runtime.server.ts:52-55`) — the deny lists are the real fence. Replace:

**`:36-38`** (module docstring, last paragraph):

```
 * Which tools are offered depends on the operator's capability policy: a
 * capability in `off` mode ("don't recommend") is withheld — its tool is not
 * even built (mirrors the operator RBAC). `allowedTools` then AUTO-APPROVES
 * these tools; under `bypassPermissions` it does not remove anything from the
 * model's context, so it is not the fence. What actually stops a server-spawned
 * operator writing code is the DENY list (`claude-runtime.server.ts:163-255`,
 * applied at `:576-583`) plus the fact that no repo-write tool is built here.
```

**`:366-371`** (inside `buildOperatorToolkit`, the `allowedTools` push):

```ts
  // Their tools must also be auto-approved: `allowedTools` is the approval
  // list, not a restriction (P14-KM-12) — without the entry every org MCP call
  // would stall on a permission prompt no human is there to answer.
```

**`:16-18`** (the `allowedTools` field doc on `OperatorToolkit`): "The
`mcp__viberr__*` tool names the run is confined to." → "The `mcp__*` tool names
this run auto-approves (confinement is the deny list, not this)."

---

## H5 — remove the decorative `viberr` MCP toggle (KM-14)

The operator template's `mcps: [viberr]` grant changes nothing in either
direction: `buildOperatorToolkit` mounts the in-process server unconditionally,
and `resolveSpecialistMcpServers` skips the reserved name. It is still offered
as a real-looking toggle. Three coordinated edits (all or none — dropping the
catalog entry alone would paint the seeded grant as a red "missing" chip):

1. **`app/server/org/resource-catalog.server.ts:49-57`** — build `mcpIds` from
   the registry only, for both profile kinds:

   ```ts
   // P14-KM-14: `viberr` is mounted unconditionally by the operator toolkit and
   // skipped by the specialist resolver, so granting or revoking it changed
   // NOTHING — it was a toggle over a decision the product had already made.
   const mcpIds = new Set<string>();
   for (const m of safe(() => listMcpServers(db))) mcpIds.add(m.name);
   ```

   `RESERVED_OPERATOR_MCP` stays exported (`specialist-mcp.server.ts` has its own
   `RESERVED_MCP_NAMES`; check for other importers before deleting it).
   `resource-catalog.server.test.ts` asserts the old superset — reshape it to the
   new contract.

2. **`app/server/seed/assets/operator.profile.md:21-23`** — `mcps: []` (drop the
   `- viberr` line), with a note matching the `kb: []` note above it.

3. **`app/features/agents/create-profile-modal.tsx:806-818`** — the client-side
   `viberr` filter becomes dead once the catalog never contains it. Remove the
   `resCatalog` mapping and use `resourceCatalog ?? []` directly.

Existing stores keep a `viberr` string in their deployed operator snapshots; it
will render as a removable red `missing` chip, which is honest — it grants
nothing. If that is unwanted, the lead can run
`updateResourceReferences("mcps", "viberr", null)` once at boot.

---

## H6 — `app/app.css`: three classes for the new browser UI (cosmetic only)

The editor cluster renders and works without these — the destination `<select>`
falls back to browser chrome, the path line to an unstyled div, and an openable
row loses its pointer cursor. Add near the existing `/* ---------- KB file
browser ---------- */` block (`~:3018`):

```css
/* P14-KM-08: a text doc row opens the in-place editor. */
.fm-row.openable { cursor: pointer; }
/* P14-KM-08: the destination every toolbar action writes into. */
.fm-toolbar select {
  border: 1px solid var(--border); border-radius: var(--radius-button);
  padding: .3rem .45rem; background: var(--surface); color: var(--fg);
  font-family: var(--font-mono); font-size: .76rem;
}
.fm-toolbar label.fm-hint { margin-left: auto; }
```

and next to `.fm-doc-acts` (`~:3140`):

```css
/* P14-UI-61: an OPENED document shows its real path — the name is the file's
   own and is not retyped, so there is no name input to style here. */
.fm-doc-path { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); }
.fm-doc-acts .fm-hint { margin-left: 0; margin-right: auto; }
```
