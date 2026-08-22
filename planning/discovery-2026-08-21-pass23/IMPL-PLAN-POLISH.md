# Pass 23 — implementation plan for the owner-approved polish items

Branch: a fresh `fix/pass23-polish` off `main` (independent of PR #194/#195).
Each item ships with a focused test; tsc + full suite must stay green.

## Item A (Q3, owner-approved) — first-clone "Preparing workspace" progress hint
**Problem:** the first task on a project does a bare clone of the whole repo into a
shared mirror (slow, one-time; ~2 min for akin-ozer/viberr). The run step already says
"Cloning <repo>" (`specialist-run.server.ts:~1296`, `operator-run.server.ts:1210`), but
it doesn't tell the human this is a ONE-TIME first-task mirror setup, so it reads as stalled.

**Approach:** distinguish the first clone (mirror absent) from a cache refresh (mirror
present). `repo-mirror.server.ts` already knows: `projectRepoMirrorDir(...)` +
`existsSync(path.join(mirrorDir, "HEAD"))` (line 248) determines existence.
- Add a tiny helper `projectMirrorExists(projectSlug, repo, dataRoot)` to
  `repo-mirror.server.ts` (or export the HEAD-exists check).
- In `specialist-run.server.ts` (~1296) and `operator-run.server.ts` (~1210): when the
  mirror does NOT exist yet, set step to
  `Cloning ${repo} — first task, one-time shared-mirror setup` (subsequent tasks keep
  `Cloning ${repo}`).
**Test:** unit-assert the step string picks the first-clone variant when the mirror dir
has no HEAD, and the plain variant when it does. (Or test the helper + the step selector.)

## Item B (Q2, owner-approved) — delete-confirm surfaces PROJECT-deployment grants
**Problem:** `resources-panel.tsx` `grantTail(usedBy(...))` counts only ORG TEMPLATES
(`gagents.filter(a => a[key].includes(slug))`). A PROJECT-deployed agent that grants the
KB/MCP is silently repointed/dropped by `updateResourceReferences`; the confirm says "No
agent template grants it" even when a project agent does (P14-KM-09, deliberate — owner
now wants the fuller disclosure).

**Approach:**
- New server helper (e.g. `resource-catalog.server.ts` or `gagents.server.ts`):
  `countProjectDeploymentsGranting(db, kind: "skills"|"mcps"|"kbs", slug): number` —
  iterate `listProjects(db)` (board-query), read each project's agent deployments
  (agentPolicy resources), count those whose `resources[kind]` includes `slug`.
- Loader (`org.settings.tsx:84`): compute the project-grant count per resource and pass
  it into the view (a parallel map keyed by slug, per kind).
- `resources-panel.tsx` `grantTail`: extend to take BOTH counts and word them, e.g.
  templates>0 → "…dropped from N agent template(s) and every project that deployed them";
  templates==0 && projects>0 → "No agent template grants it, but N project agent(s) grant
  it — their grant will be dropped"; both 0 → "Nothing grants it."
**Test:** unit — a KB granted by a project deployment (not by any template) yields a
project-grant count of 1 and the tail names it; a KB granted by neither yields "Nothing
grants it."

## Sequencing
Implement A first (smaller, isolated), then B. Validate each: tsc, targeted tests, full
suite. Then the AREAS-TO-IMPROVE.md backlog (subagent) — triage its items: implement
genuine bugs, ask the owner about further design decisions, note already-fixed.
