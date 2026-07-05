# Feature: Model + effort (reasoning) picker for agent profiles

## Problem

Agent profiles hardcoded `model: "claude-sonnet"` (claude) / `"codex-large"`
(codex). `"claude-sonnet"` is **not a valid model id**, so a real Claude run
failed with *"model may not exist"*. Profiles also had no way to choose a
reasoning **effort** level, and no effort was ever passed to the SDKs.

This feature adds a **Model** picker and an **Effort** picker to the agent
create/edit modal, populated with the real, valid choices for the selected
backend, and threads the chosen effort into runs.

## The catalog (`app/server/runtimes/model-catalog.server.ts`)

`getModelCatalog(backend): Promise<ModelCatalog>` where

```
ModelCatalog = {
  models: { value, displayName, description, supportsEffort, efforts?: string[] }[],
  efforts: string[],       // backend-wide superset
  defaultModel: string,
  defaultEffort: string,
}
```

Two layers:

- **Curated (always available)** — works with no credential, offline, and in
  tests. No spawning, no network.
  - **claude** → family aliases `sonnet` / `opus` / `haiku` (value = alias; the
    CLI/SDK resolve each to the latest model of that tier the account can use,
    so they are always valid). `supportsEffort: true`. Efforts
    `['low','medium','high','xhigh','max']`. Defaults `sonnet` / `high`.
  - **codex** → a small hand-maintained model list (`gpt-5-codex`, `gpt-5`,
    `o4-mini`). Efforts `['minimal','low','medium','high','xhigh']`. Defaults
    `gpt-5-codex` / `medium`. **Codex has no models endpoint**, so this list is
    a best-effort snapshot and is intentionally editable in the source.
- **Enhanced (claude only)** — when `isBackendAvailable('claude')`, a
  lightweight `query()` is created only to call `.supportedModels()`, returning
  the **live** list for the account/subscription. Each row is mapped to the
  catalog shape (respecting `supportsEffort` + `supportedEffortLevels` per
  model). The curated `sonnet`/`high` defaults still anchor the default
  selection. The result is cached in-process (`Symbol.for` global) with a
  **10-minute TTL**. The live fetch has a **15 s timeout**; on any
  throw/timeout/empty result it silently falls back to curated. The SDK query
  fn is **injectable** (`deps.claudeQueryFn`) exactly like the adapters, so
  tests use a fake and never spawn real Claude. Codex is **curated-only** (no
  list endpoint).

`resetModelCatalogCache()` is exported test-only.

### Live vs. curated at a glance

| | claude | codex |
|---|---|---|
| curated fallback | sonnet/opus/haiku aliases | gpt-5-codex/gpt-5/o4-mini |
| live enhance | yes (`supportedModels()`, cached 10 min) | no (no endpoint) |
| needs credential | only for the enhance | never |

## Resource route (`app/routes/resources.model-catalog.ts`)

`GET /resources/model-catalog?backend=claude|codex` — `requireUser`, returns
`{ data: ModelCatalog }`. Reading is open to any signed-in user (V1 read RBAC;
profile CRUD is the gated action). An unknown/missing `backend` defaults to
`claude` so the modal always renders. Registered in `app/routes.ts` as the one
new route line.

## Profile form + storage (`app/features/agents/agent-profile-actions.server.ts`)

- `profileFormSchema` gained `model: z.string().default("")` and
  `effort: z.string().default("")` (optional/defaulted so older clients still
  parse).
- `createAgentProfile` / `updateAgentProfile` now write
  `definition.model = form.model` (**no more hardcoded `"claude-sonnet"`**) and
  `definition.effort = form.effort`. When the form omits a pick they fall back
  per-backend to the catalog defaults (`sonnet`/`high`, `gpt-5-codex`/`medium`)
  — a **valid** model id in every case. The operator keeps its own runtime
  label + any existing effort.
- `app/schemas/project-file.schema.ts` gained an explicit optional
  `agentDeploymentDefinitionSchema` (still `.loose()`) with an optional
  `effort` field, wired onto `agentDeploymentSchema.definition`.
- `agents-query.server.ts` `AgentDeploymentDefinition` + parser now carry
  `effort`; `effectiveProfileView` surfaces it, and `AgentProfileView` (client
  shape) gained `effort: string`.

## Effort threading into runs

`effort` flows: **profile `definition.effort`** →
`resolveDeployedSpecialist().effort` → `startSpecialistRun` →
`startRun({ …, effort })` → `RunSpec.effort` → adapter:

- **claude adapter** sets `options.effort` when `spec.effort` is present
  (`ClaudeQueryOptions.effort`); absent → the SDK default (`high`) applies.
- **codex adapter** sets `startThread({ modelReasoningEffort })` when present.

`StartRunInput` and `RunSpec` gained optional `effort?: string`. `resumeRun`
and the mention/comment reply path (`agent-reply.server.ts`, owned by another
change) do **not** carry effort — the run row does not persist it, so resumes
use the SDK default; this is acceptable and out of scope here.

`resolveClaudeModel` already maps a picked `sonnet` (or a dated id) through
fine, so a run started from a profile with `model: "sonnet"` passes a valid id.

## UI (`app/features/agents/create-profile-modal.tsx`)

- On open (edit) and whenever the backend radio changes (create), a
  `useFetcher` loads `/resources/model-catalog?backend=<backend>` (loading
  state on the selects). Because the endpoint always returns the curated
  fallback, the pickers populate even with no credential.
- A **Model** `<select>` (displayName as the label, description as `title` +
  a subtitle hint) and an **Effort** `<select>` (labels from the catalog
  efforts) sit in a `field-row` right under the backend picker.
- Defaults come from the catalog once it loads; a seeded edit value not in the
  catalog is preserved and still rendered.
- Effort is **hidden** when the selected model reports `supportsEffort: false`;
  the effort options narrow to the model's own `efforts` when it constrains
  them, else the backend-wide list.
- Selects are styled inline to mirror `.field input` (this feature does not own
  `app/app.css`, which has no `<select>` rule).

## Defaults summary

| backend | default model | default effort |
|---|---|---|
| claude | `sonnet` | `high` |
| codex | `gpt-5-codex` | `medium` |

## Tests

- `model-catalog.server.test.ts` — curated fallback (both backends), the
  live-fetch path via an injected fake SDK (mapping `supportsEffort` +
  `supportedEffortLevels`), the in-process cache (second call does not
  re-query), and graceful fallback on throw/empty.
- `model-catalog-route.server.test.ts` — auth (302 signed-out), curated shape
  per backend, unknown backend → claude. Forces `claude` unavailable so it is
  deterministic against an ambient dev credential.
- `agents-route.server.test.ts` — `profileFormSchema` accepts `model`/`effort`;
  create stores `definition.model`/`definition.effort` (round-trips through
  `project.md`); the old create test updated (no more `codex-large`).
- `claude-runtime.server.test.ts` / `codex-runtime.server.test.ts` — effort
  threads to `options.effort` / `modelReasoningEffort` (and is omitted when
  absent) via injected fakes.
- `run-service.server.test.ts` — `startRun` forwards `input.effort` onto the
  `RunSpec` handed to the adapter.
- `specialist-run.server.test.ts` — `resolveDeployedSpecialist` returns the
  picked `model` + `effort`.
- `agents-page.test.tsx` — jsdom smoke: the modal renders Model + Effort
  dropdowns populated from the catalog (via a `createRoutesStub` loader),
  defaults apply, edit mode seeds the picks, submit carries `model`/`effort`.

All existing tests stay green (845 total, was 799 + new).

## Verify

`npm run typecheck && npm test && npm run build` — all clean.

Manual: create a Claude agent, pick model `sonnet` + effort `high`; confirm
`projects/<slug>/project.md` stores `model: sonnet` and `effort: high` under the
deployment's `definition`. Assign it to a task and start a run — the run passes
`model: "sonnet"` and `effort: "high"` to the Claude SDK (`options.model` +
`options.effort`). With no credential the simulated engine carries the run and
the model/effort still round-trip through the profile.

## Deviations / notes

- The SDK field is `supportedEffortLevels` (the brief said
  `availableEffortLevels`) — mapped accordingly.
- The lightweight enhance query is created solely to call `.supportedModels()`
  and is never iterated; it is best-effort `interrupt()`-ed afterward.
- Curated codex ids are a hand-maintained snapshot (documented as editable).
- Resume runs / the mention-reply path do not thread effort (run row does not
  persist it) — out of scope and owned by a concurrent change.
- No new audit action (the catalog route is read-only).
