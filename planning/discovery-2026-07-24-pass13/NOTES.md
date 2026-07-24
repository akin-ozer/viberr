# Pass 13 — running discovery notes (2026-07-24)

Base: `main` @ c7abebf (pass-12 PR #94 merged). Dev server via launch.json `viberr-dev`
on :5173, data root `docker-data/` (the Docker container was `docker compose stop`ped so
only one process owns the data root). Login `arda@viberr.dev`.

Owner focus for this pass: **knowledge bases and MCP servers**, plus agent creation /
operator selection / stage transitions / reviewers / secondary assignments / comments /
RBAC / skill isolation / Claude↔Codex parity.

## Starting state of the instance (inherited from the owner's own live run)

- 1 project `viberr` → repo `akin-ozer/viberr`, Standard 5 stages, balanced policy.
- 1 task VIB-1 "list all files in this project" — Done, PR #97 merged (a real owner-driven
  run: operator → Codex Developer → Claude Reviewer → human accept → merge).
- **0 GitHub connections** at boot (the earlier one had been removed) — the owner re-added
  a PAT for `akin-ozer` during this pass.
- 0 KBs, 0 MCP servers, 3 skills, 2 specialist profiles + operator, 1 user (Arda).
- The `viberr` project's member row and VIB-1's `ownerUserId` both point at
  `u_RT7-QeTWOwP4`, which **no longer exists** in `users` (current Arda is
  `u_Ta3NH0znVm86`) — a stale id inherited from an earlier baseline. This exposed a real
  honesty bug (see P13-04).

## What I exercised live in the UI (this session)

| Surface | Result |
| --- | --- |
| `/` home | ok — empty-ish state honest, settings strip counts correct |
| `/org/settings?tab=connections` | ok — PAT validated, scopes shown, "3 repos" |
| `?tab=users` | ok (copy nit: "1 instance accounts") |
| `?tab=resources` | KB create + GitHub import + MCP add all work; **profile card renders the whole persona** (P13-01) |
| KB store browser | Upload files / Upload folder / Add from GitHub / New folder / drag-drop; **no way to author a file in-app** (P13-06) |
| KB "Add from GitHub" | honest failure with 0 connections; with a PAT: 6 files imported from `akin-ozer/viberr/docs`, nesting preserved, "snapshot, not a live sync" |
| MCP add (stdio) | REAL discovery: `npx -y @modelcontextprotocol/server-everything stdio` → "13 tools discovered", green up dot |
| `/projects/viberr` board | ok; **5 columns overflow at 1280px** and the Done card clips (P13-08) |
| `/projects/viberr/tasks/VIB-1` | rich, real timeline; **Waiting-on stuck on "Human decision" for a Done+merged task** (P13-03); owner renders as raw id (P13-04); "Goal drafted" renders under a **"Policy violation"** pill (P13-02) |
| `/projects/viberr/agents` | ok — profiles, eligible stages, capability policy, capability matrix modal honest about Codex being advisory |
| `/projects/viberr/policy` | ok — RBAC matrix + agent capability counts; member shown as raw id (P13-04) |
| `/projects/viberr/github` | honest "no credential" state; attach works, **but the Connection pill stays "no credential" until you press "Update status"** (P13-05) |
| `/projects/viberr/activity` | ok — stream + audit log, my credential attach was audited |
| `/projects/viberr/settings` | ok — stages, members, repo/credential, task-level override |
| `/projects/viberr/review` | ok — empty state correct |
| `/notifications` | ok — empty state correct |

## Findings raised from live inspection (detail in FINDINGS.md)

- **P13-01** org "Global agent profiles" card prints the entire persona body as the row
  subtitle; the org-level editor has no persona field at all and writes the one-line
  Role summary into the profile body (the run's system-prompt material).
- **P13-02** benign events (`Goal drafted`, `Goal updated`, delivery notes) are emitted as
  `type:"policy"`, which the timeline labels **"Policy violation"** with a shield.
- **P13-03** a Done + merged task still reports `Waiting on: Human decision`; the board
  counts it ("1 waiting on a human decision") while the review queue says 0.
- **P13-04** an unresolvable user id renders as the raw `u_…` string in the task owner
  widget, the human-owner panel, the policy member row and project settings members.
- **P13-05** attaching a project GitHub credential doesn't refresh connection health.
- **P13-06** KBs can only be filled by upload/import — no in-app "new file"/editor.
- **P13-08** board columns overflow the viewport at 1280px with a clipped card.

## Open questions for the owner (raise when they firm up)

- KB/MCP editing model: should a KB be authorable in-app (create/edit a doc), or is
  "upload + import + agents append" the intended ceiling?
- Should the org-level profile editor own the persona (system prompt), or is persona
  authoring deliberately project-level only?
