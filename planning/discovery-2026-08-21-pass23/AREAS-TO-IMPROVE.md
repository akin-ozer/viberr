# Pass 23 — areas to improve (discovery backlog)

Critical, prioritized backlog of genuine gaps for the next implementation phase.
Every item is grounded in code read this pass (file:line) or in this pass's live
log. Already-fixed pass-23 bugs are NOT re-listed: **BUG-1** (web-egress editor
display + silent on→off flip) → **PR #194**; **BUG-2** (@operator "picking it
up" toast on a refused run) → **PR #195**. Pass-22's shipped F1–F4 (boot
self-heal, seed Developer→Claude, model-availability signal, github_read) are
treated as DONE and excluded.

Severity: HIGH = an admin/user is actively misled or real work is lost/blocked;
MEDIUM = confusing, wasteful, or a real gap with a workaround; LOW = polish.

---

## A. Coherence / honesty (UI says X, runtime does Y)

### A1. HIGH — BUG-1's display fix reached only the editor: the capability MATRIX, the read-only profile DETAIL, and the POLICY counts still misrepresent absent permissive-default grants

The owner ruling on BUG-1 kept web egress ON for an absent
`use-web-search-fetch` grant and fixed the EDITOR to seed absent toggles from
the effective runtime mode (`create-profile-modal.tsx:148-185`, PR #194). But
every OTHER capability surface still renders only the PERSISTED grants:

- `effectiveProfileView` builds a specialist's grants from
  `deployment.capabilities` alone — an absent grant produces NO row
  (`app/features/agents/agents-query.server.ts:310-319`, buckets at `:389`).
  The one materialization that exists is operator-only `deliver-review-pr`
  (`agents-query.server.ts:295-309`) — the exact pattern the rest needs.
- The **capability matrix** maps "not in any bucket" to **"Not granted"**
  (`app/features/agents/capability-matrix-modal.tsx:25-32`, legend `:118-121`).
- The **profile detail** panel's three columns filter the same buckets, so an
  absent capability is simply OMITTED (`app/features/agents/agents-page.tsx:648-653`,
  columns at `:807-811`).
- The **Policy page** per-profile counts ("N direct") sum the same buckets
  (`app/features/policy/policy-page.tsx:319-333`).

Concrete live instances on a FRESH SEEDED install (the default experience): the
seeded Operator, Developer and Reviewer all omit "Search & fetch from the web"
(`app/server/seed/agent-catalog.server.ts:110-112,153-155,179-184`), so the
matrix shows their web-egress cells as **"Not granted"** while WebFetch/WebSearch
run (live-proven in BUG-1; operator polarity confirmed at
`app/server/runtimes/operator-run.server.ts:991,2355` — absent ⇒ tools kept).
The matrix's own footnote even says "The Claude operator can reach the web …
when Search & fetch from the web is granted"
(`capability-matrix-modal.tsx:272-276`) directly above a cell claiming it is not
granted. Same family: the seeded Developer omits `attach-evidence-references`
(catalog default `direct`, `app/shared/capabilities.ts:138`) — matrix says "Not
granted", the completion pipeline honors it.

Why it matters: post-#194 the three read surfaces now contradict the EDITOR too
(editor: "Allowed"; matrix/detail/policy: "Not granted"/omitted). An admin
auditing egress from the matrix — the surface built for exactly that audit —
gets the wrong answer, the BUG-1 threat model unchanged.

Fix direction: materialize every catalog capability for display at its
runtime-effective mode in `effectiveProfileView` (mirror the
`deliver-review-pr` materialization, keyed off `GRANT_REQUIRED_CAPABILITY_IDS`
+ catalog `defaultMode` — the single source of truth PR #194 established in
`app/shared/capabilities.ts:393-400`). One writer, all four surfaces agree.
Optionally distinguish "granted (default)" from "granted (explicit)" in the
cell title so an explicit `off` (a real withholding, honest "Not granted")
stays distinguishable.

### A2. MEDIUM — KB/MCP/skill delete-confirm counts only ORG-TEMPLATE grants; project-deployment grants are silently dropped, and both copy branches under-describe

Verified this pass live (UC-18 minor observation) and in code:

- `usedBy` counts references over `gagents` — the org TEMPLATE layer only
  (`app/features/org-settings/resources-panel.tsx:136-137`).
- The confirm tail renders `grantTail(templates)`: zero ⇒ **"No agent template
  grants it."** (`resources-panel.tsx:36-40`, used at `:290-303`) — read by an
  admin as "nothing uses this".
- Meanwhile the delete mutation runs `updateResourceReferences(…, null)` which
  ALSO walks every `project.md` and silently drops the grant from every project
  DEPLOYMENT (`app/server/org/resource-references.server.ts:138-182`) — the
  live case: the Viberr project's developer granted the KB, tail said "No agent
  template grants it", and the grant was dropped without a word.
- The >0 branch is wrong too: "dropped from N agent templates **and from every
  project that deployed them**" — but `rewriteProjects` drops the grant from
  ALL deployments, including project-CREATED agents that never came from a
  template.

Why it matters: the delete confirm is the last guardrail before a destructive
change (the P14-KM-09 rationale), and it makes a false "unused" claim exactly
when only project agents use the resource.

Fix direction: compute a second, server-side count of project-deployment grants
(the same walk `rewriteProjects` does, read-only — or extend
`listGagents`/resources loader with a per-slug deployment reference count) and
render a two-part tail: "N template grant(s) + M project agent grant(s) will be
dropped" / "No template or project agent grants it."

### A3. MEDIUM — @mention comment that fails to start the agent run: the comment IS posted, but the user only sees an error (the BUG-2 shape, specialist branch)

PR #195 fixed the OPERATOR refusal path. The SPECIALIST paths still have the
partial-success gap: `commentToAgent` records the comment (base) FIRST, then
`startAgentRun` / `resumeRun` can throw — single-flight conflict, backend not
configured, stage-eligibility (`app/server/tasks/task-actions.server.ts:1252-1318`;
throws propagate to the route's catch at
`app/routes/project.task.tsx:987-989`). An `AppError` becomes a bare error
toast (`app/server/auth/form-action.server.ts:24-30` →
`task-detail-hooks.ts` `push(d.error, "error")`); anything else re-throws to
the error boundary. Either way, nothing tells the human "your comment DID
post — only the run didn't start", and the composer's draft handling treats it
as a failure.

Fix direction: same shape as #195 — catch run-start failures inside
`commentToAgent`, return `triggered: null` plus a typed `runStartFailed`
reason, and let the route toast "Comment posted · run not started: <reason>".

### A4. LOW — stale cross-reference: specialist-mcp doc points at a TODO that F21-3 already resolved

`app/server/tasks/specialist-mcp.server.ts:227-229` still says the operator
"should call this after resolving too — see the TODO left at its mount site",
but the operator HAS run the same pre-flight since F21-3
(`app/server/runtimes/operator-run.server.ts:2401-2417`). Doc-rot on a
security-relevant function; one-line fix.

---

## B. Capability model

### B1. MEDIUM — the profile EDITOR discloses no per-capability enforcement scope (the matrix's "Claude-enforced" tag is absent where grants are actually made)

The capability matrix tags claude-only rows ("Claude-enforced … advisory on
Codex", `app/features/agents/capability-matrix-modal.tsx:156-170`, legend
`:122-125`), driven by `capabilityEnforcement`
(`app/shared/capabilities.ts:285-296`). The EDITOR — the surface where an admin
actually sets modes — imports none of it (`create-profile-modal.tsx` has no
`capabilityEnforcement` usage; verified by grep). Consequences on a
Codex-pinned profile:

- Granting **`read-github-api`** shows a normal "Allowed" toggle, but the tool
  is NEVER mounted on Codex (deliberate credential-security design,
  `app/shared/capabilities.ts:118-128,270-283`) — the grant is inert and the
  editor doesn't say so.
- Withholding **`execute-code-or-write-repo`** (and the scoped delivery caps,
  `comment-on-task`) reads as enforcement but is advisory on Codex since R22
  removed the sandbox (`capabilities.ts:260-283`).

The editor already knows the profile's selected backend (it holds backend
state for the model picker), so a per-row scope hint — or at least the matrix's
tag — is cheap and prevents an admin from believing a Codex profile is confined
by a toggle that cannot bind there.

### B2. MEDIUM — backend quota exhaustion still has zero pre-run signal (carried from pass 22, refined by this pass's live VIB-5)

Deliberate design: quota/auth failures are never persisted as availability
marks (`app/server/runtimes/model-availability.server.ts:25-31` — only
"model not supported" sentences match `MODEL_UNSUPPORTED_RE`). So pass-22 F3's
run-control warning covers the unsupported-model class only. Live this pass
(VIB-5): the operator engaged the Codex Dev, the run spent the engagement and
failed on quota, and the recovery packet ("Retry on Claude") closed the loop —
graceful, but every future assignment to that profile until **Sep 18** will
repeat the fail-then-recover cycle with no "Codex is over quota until <date>"
hint at assignment or on the run control. The provider message literally
carries the retry date (LIVE-LOG VIB-5).

Fix direction: a short-TTL TRANSIENT signal (in-memory or a
`model_availability`-adjacent table with `kind: "quota"` and `expiresAt` parsed
from the provider sentence), surfaced in the same run-control/agent-card slot
F3 built — expiring automatically so it never becomes the stale pseudo-check
ruling 19 bans. Needs an owner nod since pass-22 Q2 left it open.

---

## C. Error handling / robustness

### C1. MEDIUM — attachments store: silent 100-file truncation, no quota, no retention (carried from pass 22 — still open)

`app/server/files/task-attachments.server.ts:35,64` — `LIST_CAP = 100`,
`entries.slice(0, LIST_CAP)` with no truncation flag; the panel renders the
list with no "N more not shown" (`app/features/task-detail/attachments-panel.tsx`
has no cap/truncation copy — verified by grep). A browser-capable agent saves
snapshots every run (live VIB-4 saved page snapshots automatically), so a
long-lived task can silently hide its OLDEST evidence — precisely the files a
dispute would need. No size quota and no retention policy exist on the store
(module header `:8-25` says so deliberately). The mtime-window attribution
(`attachmentNamesSince`, `:67-75`) also re-attributes a same-named file to the
later run — acceptable, but documented only in a comment.

Fix direction: return `{ entries, total }` and render "showing 100 of N";
decide quota/retention with the owner (evidence is an audit artifact — silent
eviction may be worse than growth; even a per-task byte count on the panel
would help).

### C2. LOW/MEDIUM — workspace reclamation runs at BOOT only; a never-restarted instance accumulates Done-task clones indefinitely

`app/server/tasks/workspace-retention.server.ts:39-41` — reclamation of
terminal-stage task workspaces is "Called at boot" only. A long-running
container (the normal self-host mode) never reclaims until its next restart;
with the R21-4 mirror each workspace is hardlinked (cheap on one filesystem)
but still a full tree per task. Related visibility gap: nothing in Instance
settings shows disk usage for `.repo-mirror` caches (unbounded by design,
`app/server/tasks/repo-mirror.server.ts:23-49`), task workspaces, or
attachments. Fix direction: a periodic reclamation tick (the schedule runner at
`schedule.server.ts:46` shows the pattern) and/or a storage line in
diagnostics.

---

## D. UX / first-run

### D1. MEDIUM — first task in a project: "Preparing workspace · Cloning owner/repo" is a static label for a multi-minute cold clone (observed live: ~2 min on a 129 MB repo)

The R21-4 reservation made the strip EXIST during the clone (a big win), but
the phase/step never changes for the whole download:

- Step set once: `` `Cloning ${repo}` `` (`app/server/tasks/specialist-run.server.ts:1294-1296`),
  next update only AFTER the clone ("Mounting the agent's granted resources",
  `:1333-1336`).
- The clone itself runs `git clone` with no `--progress` capture
  (`app/server/tasks/repo-mirror.server.ts:288-291` for the mirror create,
  `:433-435` for the local cut) — nothing to feed a progress step from.
- The strip shows the static step + elapsed clock
  (`app/features/runtime/runs-panels.tsx:210-241`).

Live (VIB-1): ~2 minutes of an unchanging "Cloning akin-ozer/viberr" — it
"looks stalled for minutes" (LIVE-LOG). Only the FIRST task pays this (the
mirror serves later tasks in seconds), which is exactly why it lands on the
first-run experience.

Fix direction (either or both):
1. Cheap honesty: `cloneWorkspaceRepo` knows when it is CREATING the mirror
   (the cold path, `repo-mirror.server.ts:283-291`); thread that out so the
   step reads "Cloning owner/repo — first task in this project, this can take
   a few minutes". No git plumbing.
2. Real progress: spawn the mirror-create clone with `--progress`, parse
   `Receiving objects: NN%` from stderr, and call
   `pending.reservation.phase(...)` on a throttle — the reservation API
   already supports step updates (`specialist-run.server.ts:1333`).

---

## E. Test coverage

(Verified/expanded below by the risky-logic sweep; personally confirmed item:)

### E1. MEDIUM — the four-surface capability display (A1) has no cross-surface agreement test

`agents-page.test.tsx` gained the editor-seeding test in PR #194, but no test
asserts the matrix/detail/policy render of an ABSENT permissive-default grant
matches the runtime (`resolveSpecialistDisallowedTools`). A1's fix needs a
pinning test of exactly that (the F15-20 "display asserts a mode the runtime
does not use" class — third recurrence: F15-20, BUG-1, A1).

---

## F. Other / held (owner decisions, carried forward)

- **Browser-agent authenticated browsing** (pass-22 A1 / Q1) — still held; the
  browser sees only the public web. Owner call.
- **D7 / D10 / D11 / D12** (pass-20 R20-5 held list: packet
  impact/confidence/severity fields, continuity-panel escalated/paused states,
  execution-truth-strip continuity, skeleton loaders) — never-built PRD
  features, still held.
- **Residual layering** (pass-22 B6) — server modules still import from
  `features/agents`: `app/server/tasks/specialist-run.server.ts:37,76-78`,
  `operator-actions.server.ts:8,60`, `task-actions.server.ts:135`,
  `app/server/org/resource-catalog.server.ts:4`,
  `app/server/projections/agent-deployments.server.ts:7`. The pass-22 #183
  work moved deployment-view; the display-view engine (`effectiveProfileView`)
  remains a deliberate deferred refactor.
