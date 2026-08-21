# PRD alignment — pass 22 (2026-08-21)

**Scope.** Every functional requirement and spec claim in the planning canon
(`planning/planning-artifacts/prd.md`, `architecture.md`,
`ux-design-specification.md`, plus the binding rulings in
`docs/architecture/decisions.md`) walked against source at `main` HEAD
`26fca45`, with special attention to the post-pass-21 PRs #176–186. Read-only
pass; no source was changed. Every verdict below carries a file:line citation
into the tree at this HEAD.

**Classification.**

- **DOC-STALE** — the app moved deliberately (ruling / amendment / commit trail
  exists); the document is what needs correcting.
- **APP-DRIFT** — the app diverged with no visible intent trail; candidate bug
  or unowned change.
- **AMBIGUOUS** — cannot tell from the trail; an owner question is queued.

**Headline counts.** ~105 discrete claims walked (39 FRs, 18 NFRs, ~25
architecture claims, ~20 UX-spec claims, ~30 ruling spot-checks).
**Aligned/verified: 91 · DOC-STALE: 12 · APP-DRIFT: 2 · AMBIGUOUS: 8**
(the ambiguous items are the eight owner questions at the end).

---

## 1. The post-pass-21 PRs (#176–186) and what canon knows about them

Since the pass-21 merge (`d1bc4a2`), only two commits touched any canon file,
and both touched `docs/architecture/decisions.md` alone: `9317ccc` (ruling 91 /
R21-8) and `01daead` (ruling 92 / R21-9). `planning/planning-artifacts/prd.md`,
`architecture.md` and `ux-design-specification.md` received **zero** updates
for this whole batch (verified: `git log d1bc4a2..HEAD -- planning/planning-artifacts/`
returns nothing). The `design/prd.md` mirror is byte-identical with canon
(`prd-sync.test.ts` still holds), so the mirror is not the problem — the canon
itself is behind.

| PR | Commit | What shipped | Owner-ruling trail | Canon record |
|---|---|---|---|---|
| #176 | `86c5e35` | Browser grant carries web egress with it (`repairBrowserEgressGrants`, editor pin, save-layer repair + notices/audit) | Owner ruling 2026-08-20, stated in the commit message only | **NONE** — no ruling number, no amendment on ruling 75 |
| #177 | `ba0ea9c` | Attachments render on the producing comment (timeline thumbnails); agent attachment-shaped links rewritten to the serving route | Owner report 2026-08-20 (commit message) | NONE |
| #179 | `461b781` + `c0bc031` | The attachments drop: agents post files on the task thread (persona section, Codex sandbox widening, workspace-contract exception) | Owner ask 2026-08-20 (commit message) | NONE |
| #180 | `f638ffe` | Decision packet takes the questionnaire's density | Owner ruling 2026-08-20 (commit message) | NONE |
| #181 | `9317ccc` | input_required yields to agent-working during a live run | **Ruling 91 (R21-8)** | decisions.md only — UX spec State Semantics not amended |
| #182 | `287b6b8` | Packet reads as one quiet column (evidence rows, one type ramp) | Owner feedback 2026-08-21 (commit message) | NONE |
| #183 | `9b86de1` | Display overlays the LIVE deployment backend over the engage-time snapshot (`withLiveAgentBackends`) | Owner report (commit message); ruling 92 cites it obliquely as "the R21-8/#183 law" | No ruling of its own; the ruling-92 cross-reference is wrong (R21-8 is the unrelated pill-yield ruling) |
| #184 | `8906342` | Image evidence opens an in-app lightbox | Owner request (commit message) | NONE |
| #185 | `01daead` | "Claude" label everywhere; operator run control shows, does not pick; steer input | **Ruling 92 (R21-9)** | decisions.md only |
| #186 | `e0ea9f0` | Owned task's owner cell is just the owner (Manage popover removed) | Owner request 2026-08-21 (commit message) | NONE |

Ruling 44 (R17-3) exists precisely because "a ruling a code comment cites but no
canon file records is a ruling that gets reversed" — and ruling 84's own
provenance note records this failure reproducing once already. Six of these ten
PRs are in exactly that state today.

---

## 2. Functional requirements walked

### Workspace access & collaboration

| FR | Verdict | Evidence |
|---|---|---|
| FR1 sign-in / shared workspaces | ALIGNED | better-auth bridge `app/lib/auth.server.ts`; login route `app/routes/login.tsx` |
| FR2 admin manages membership/roles; enforced permissions | ALIGNED | single grant table `app/shared/rbac.ts` (guards + Policy page render from it) |
| FR3 shared visibility | ALIGNED | SSE broker `app/server/events/`, `app/routes/resources.events.ts`, reconcile poller wired at boot (`app/server/boot.server.ts`) |
| FR4 app-wide commenting within visible projects; non-member labeling | ALIGNED (as amended by R15-4) | members-only 404 `app/routes/project-visibility.server.ts:40` (byte-identical 404, comment at :22); non-member actor labeling machinery survives for the org-admin-override case (`app/shared/mapping/actor.server.ts:41`); non-member task/comment POST 404s (`app/features/task-detail/timeline.tsx:228,515`) |
| FR37 owner = reviewer + acceptance authority; R14-2/R15-3 widening | ALIGNED | owner authority threaded through acceptance writers and recommendation apply/dismiss (`app/server/tasks/task-actions.server.ts`; human delivery `manualDeliverForReview` accepts "Maintainer+ or the task's own owner", `app/routes/project.task.tsx:591-599`) |
| FR38 "Any **member** … can take or release task ownership" | **DOC-STALE (A-11)** | Code floors take/release at **contributor**: `own-task … roles: [A, M, C]` (`app/shared/rbac.ts:65`), `release-any-ownership … [A]` (`rbac.ts:75`); the unowned cell says "Any contributor or above can take it" (`e0ea9f0`, Q5 tiering). Viewer is a member tier and is excluded. FR37's own amendment already says "(contributor or above)"; FR38 was never re-synced. See owner question 6. |

### Project governance & policy

| FR | Verdict | Evidence |
|---|---|---|
| FR5 self-serve creation, creator seeded admin | ALIGNED (as amended) | `app/routes/_index.tsx` ("Org role is intentionally NOT consulted here"); pinned by `workspace-routes.server.test.ts` |
| FR6 stages/transitions/approval boundaries | ALIGNED | `app/features/project-settings/`, workflow graph in `project.md` (`app/schemas/project-file.schema.ts`) |
| FR7/FR30 one repo per project, no task override | ALIGNED | override deleted P13-D-5: `app/schemas/task-file.schema.ts:532-535,1192`; `project-file.schema.ts:180-183` |
| FR8 separate RBAC + capability policy | ALIGNED | `app/shared/rbac.ts` vs `app/shared/capabilities.ts` |
| FR9 profiles: eligible stages, actions, context resources, backend | ALIGNED, **but the resource list is stale** | Profiles also grant `use-browser` (a real browser, ruling 75) and the evidence/attachments drop — neither named by FR9's "skills, MCPs, knowledge bases". See amendment C-3. |

### Task records & lifecycle

| FR | Verdict | Evidence |
|---|---|---|
| FR10 file-native store, direct-edit reconcile | ALIGNED | watcher `app/server/files/file-watch.service.server.ts` (attachments/ and workspace/ deliberately unwatched, :178,:242); rescan `scripts/rescan.ts` |
| FR11 human-only creation, entry stage only | ALIGNED | ruling 70; `createTask` refuses non-entry stage (`app/server/tasks/task-actions.server.ts`); per-lane button entry-lane-only |
| FR12 canonical operating record | ALIGNED | `app/schemas/task-file.schema.ts` |
| FR13 governed transitions | ALIGNED | `server/tasks/` governed-mutation core |
| FR14 engagements[]: exactly one delivers:true; verdictCapable snapshot | ALIGNED | schema `task-file.schema.ts:121,132,138,147,509` ("≤1 entry has delivers: true"); `verdictCapable` default false |
| FR15 flag low-quality tasks | ALIGNED (behavioral per ruling 89) | `triageQualityGate` (`app/server/runtimes/operator-run.server.ts:2797`); placeholder copy "A vague goal gets flagged by the operator at triage" (`app/features/board/board-page.tsx:1121`) — note the ruling-89 text quotes an older wording ("Underspecified goals get flagged…"); trivial, but the ruling quotes copy that no longer exists |
| FR16 typed events + chronology | ALIGNED | typed event kinds in `task-file.schema.ts`; unified timeline `app/features/task-detail/timeline.tsx` |
| FR17 validation outcomes, evidence refs, summaries, compaction | ALIGNED, **but under-scoped** | evidence rows (`app/server/tasks/evidence-rows.server.*`), compaction — all present. FR17's "linked evidence references" predates agents posting **files** onto the thread (PR #179) and the attachments surface; see amendment C-3. |

### Agent orchestration & continuity

| FR | Verdict | Evidence |
|---|---|---|
| FR18 dedicated operator per task | ALIGNED | `operator-actions.server.ts` + `operator-run.server.ts` |
| FR19 Codex/Claude backends | ALIGNED | `app/server/runtimes/{claude,codex}-runtime.server.ts`. Display label is now "Claude" (ruling 92); FR19's "Claude Code" is a product reference and stands under ruling 92's own carve-out |
| FR20 operator recommends/triggers/re-engages | ALIGNED | operator toolkit; ruling 60 hard-refuse on `off`/`human` verified (`operator-actions.server.ts:2717-2748`, F19-26 reroute close at :2599-2610) |
| FR21 specialists append outcomes/blockers/evidence | ALIGNED | `agent-outcome.server.ts`, `agent-reply.server.ts` |
| FR22 resume + re-anchor | ALIGNED | `canonical-anchor.server.ts`; recovery modules in `server/runtimes/` |
| FR23 native runtime session access | ALIGNED | `app/routes/resources.session-export.ts:33-44` — requireUser + **project membership** gate, 404 on no session |
| FR39 scheduled operator re-runs | ALIGNED, **but see Q2/Q3** | canonical in file, terminal-stage guard (`app/server/tasks/schedule.server.ts:47,97-101`); the schedule form still picks backend AND autonomy per run (`app/features/task-detail/task-main-sections.tsx:434-445`) which FR39 documents — but which now sits in tension with ruling 92's "both are configured on the deployed operator profile" |

### Oversight & human governance

| FR | Verdict | Evidence |
|---|---|---|
| FR24 board cards: stage, agent, waiting, validation | ALIGNED (+ ruling 91 yield) | `board-page.tsx`; continuity cue on cards (`board-page.tsx:322-324,375`); packet-aware slots (:529, :899-900) |
| FR25 detail: state, profile, packet before timeline | ALIGNED | `task-detail-page.tsx` / `task-main-sections.tsx` ordering; hero yield mid-run (`task-main-sections.tsx:190-203`) |
| FR26 structured packets | ALIGNED | 10 stable option kinds (`task-file.schema.ts:74-102`, matches ruling 7's count) |
| FR27 acceptance family | ALIGNED — fully | verdict gate + Force-accept-only bypass (ruling 20); `ALWAYS_HUMAN_CAPABILITY_IDS = [merge-pull-request, transition-to-done, change-project-policy]` (`app/shared/capabilities.ts:194-198`); operator acceptance = merge-pending, visible on board and queue (`board-page.tsx:229-288`, `review-page.tsx:86`); no-change path re-proves with `defaultBranchEvidence.verified` on both doors (`push-workspace.server.ts:83-84,553,665`, `no-change-completion.server.ts:53,99,184,401`); **ruling 88 acceptance-disclosure is a server invariant** — a bare POST is refused ("carried no disclosure acknowledgment", `task-actions.server.ts:6350`) and the echo is re-compared against live state (:5041,:6442), threaded through every disclosure-bearing door (:3218,:4519,:4789,:6299-6540) via the shared `~/shared/acceptance-disclosure` contract (:76-81) |
| FR28 progress without raw logs | ALIGNED | `onPhase` driven (`run-service.server.ts:302,1157`), rendered in `runs-panels.tsx` (ruling 87 half b) |

### GitHub delivery & traceability

| FR | Verdict | Evidence |
|---|---|---|
| FR29 authenticate + access repos | ALIGNED | `server/github/`, `server/secrets/` PAT store/validator |
| FR31 delivery is an operator decision | ALIGNED | `deliver-review-pr` capability (`capabilities.ts:71,220`); human escape hatch maintainer+/owner audited (`project.task.tsx:591-599`); "Review reached with no PR yet" typed event (`task-actions.server.ts:3541`) |
| FR32 branch/PR status visibility | ALIGNED | `app/features/github/`, board PR pills |
| ruling 42 divergence surfacing | ALIGNED (implemented — the ruling's "on this pass's backlog" note is stale) | "N commit(s) added since review" in the accept dialog (`accept-confirm.tsx:383-388`) |
| ruling 68 human GitHub approval as verdict | ALIGNED | `app/server/github/pr-human-approval.server.ts` exists and is threaded through the verdict gate |

### Integrity, audit & recovery

| FR | Verdict | Evidence |
|---|---|---|
| FR33 90-day audit retention, boot pass, no export | ALIGNED | `AUDIT_RETENTION_DAYS = 90` (`app/server/db/retention.server.ts:30`) |
| FR34/NFR7 secret isolation | ALIGNED | secret-box AES-256-GCM (`server/secrets/`), git/provider redaction choke points (`git-output-redact.server.ts`, rulings 69/78) |
| FR35 violations as events | ALIGNED | `app/server/projections/policy-violations.server.ts` |
| FR36 manual re-scan/rebuild | ALIGNED | rescan/rebuild actions org-admin-gated per FR5's note |

### Non-functional requirements

NFR1 (unbounded, unvirtualized board — no LIMIT in
`board-query.server.ts`: verified), NFR2/NFR5 (bounded timeline slice + run-log
paging: `timeline-slice.ts`, `resources.run-log.ts`), NFR3 (action
acknowledgment: toast/pending machinery + `toast-honesty.test.ts`), NFR4 (SSE +
poller), NFR6 (deployment's job, as written), NFR8 (MCP-outside-matrix: **no**
`mcp__*` deny rule in `specialist-tool-policy.ts` — grep returns nothing, which
is the pinned state), NFR9–NFR18: aligned at module level, nothing found
contradicting them. The ruling-63 posture (no unmeasured numbers) still holds —
no numeric latency claims have crept back in.

---

## 3. Special-attention areas

### 3a. Agent browser capability + egress coupling

- `use-browser` exists, default **off** (`app/shared/capabilities.ts:111`), in
  `ENFORCED_CAPABILITY_IDS` (:240).
- The runtime mount still refuses browser-without-egress and reports the
  contradiction (`specialist-browser-mcp.server.ts:113-121`) — ruling 75(a)'s
  backstop is intact.
- **PR #176 changed the user-facing polarity**: `repairBrowserEgressGrants`
  (`capabilities.ts:475-491`) rewrites egress to `direct` whenever browser is
  `direct`, on create/edit/deploy-from-library, with a disclosed notice and its
  own audit keys; the editor pins the egress row while browser is Allowed. The
  commit says this "deliberately diverges from B-AG1's respect-the-explicit-off."
  A contradictory stored pair is now reachable only by hand-editing files, where
  the runtime backstop still fails closed with disclosure.
- **Canon status: DOC-STALE + missing ruling.** Ruling 75(a) still teaches the
  old polarity ("a profile whose use-web-search-fetch is withheld cannot
  re-acquire egress through the browser") with no amendment marker, and the
  2026-08-20 owner ruling exists nowhere but the commit message. (Amendment C-2,
  owner question 1.)

### 3b. Attachments / evidence / lightbox

Everything shipped and verified: canonical `tasks/<KEY>/attachments/`
(`file-store-root.server.ts:11,92`), member-only serving route
(`app/routes/task-attachment.ts`, registered `app/routes.ts:52`), the drop
persona section (`specialist-browser-mcp.server.ts:167-178`) gated on the
evidence grant (`specialist-run.server.ts:1403-1406,2014-2015`), the workspace
contract's named exception (`c0bc031`), Codex sandbox widening at
workspace-write (`codex-runtime.server.ts:650-652`), timeline thumbnails +
attachment-shaped link repair (`timeline.tsx`, `markdown.tsx`), and the lightbox
(`attachment-lightbox.tsx`, four surfaces).

**Canon status: the docs actively deny this feature exists.**
`architecture.md:824` — "`attachments/` was specified here and never
implemented; **do not write to it**" — is flatly false and is now an
instruction that contradicts the product (agents are *told* to write to it).
The data-root trees in `architecture.md:799-820` and
`docs/architecture/file-formats.md:15` ("+ attachments/ later") omit it, and
both also omit the per-project mirror cache `projects/<slug>/.repo-mirror/`
(ruling 87; `repo-mirror.server.ts:34,117`) that now lives *inside* the
"authoritative" `projects/` tree. The PRD has **no FR** for agents posting
files, and the UX spec has no attachments-panel/lightbox coverage. (Amendments
C-1, C-3, C-4; APP-DRIFT AD-1 below is the one genuine defect found here.)

**APP-DRIFT AD-1 — evidence persona vs read-only Codex sandbox.** The
"Posting files on the task thread" section is emitted for *every*
evidence-granted real-backend run (`specialist-run.server.ts:1403-1406`), but
Codex widens the sandbox only at `workspace-write`
(`codex-runtime.server.ts:646-652`), and a supporting/review run is
*physically read-only* (`specialist-run.server.ts:2169-2170`). An
evidence-granted Codex **reviewer** is therefore instructed to copy files into
a directory its sandbox will refuse — the exact honesty class `c0bc031` fixed
for the workspace contract ("an exception a rule does not name is not an
exception"), reproduced one layer down. No commit addresses the read-only
case. (Owner question 4.)

### 3c. Decision packets + acceptance disclosure (R15-1 / R21-5 family)

The whole acceptance chain verified end-to-end (see FR27 row above): verdict
gate → human-approval-as-verdict (ruling 68) → merge-pending vs real merge
(ruling 40) → no-change path with live re-proof (rulings 62/77) → divergence
disclosure (ruling 42, shipped) → force-accept honesty (ruling 59) →
**server-enforced disclosure acknowledgment (ruling 88)**, which correctly
distinguishes disclosure-bearing doors from in-process callers
(`task-actions.server.ts:6324-6331`). No drift found anywhere in this family —
this is the best-kept promise in the product.

The packet **redesign** (#180/#182) is restyling with behavior preserved
(roving radiogroup, digit shortcuts, ceremonies all pinned by tests). The UX
spec's Decision Packet section survives at principle level, but its anatomy
line still lists **severity, impact summary, confidence/risk framing** —
fields the schema has never carried (no `severity`/`impact`/`confidence` on
packets in `task-file.schema.ts`; ruling 80 held these as D7) — and the spec
text itself carries no note. (Amendment C-5, owner question 5.)

### 3d. Reviewer flow

Verified: verdict-capable snapshot at engage time
(`task-file.schema.ts:138,591`), reviewer KB inheritance is KBs-only
(`deliveringContextGrants` / `withDeliveringGrants`,
`specialist-run.server.ts:352,375,1210` — skills deliberately not inherited,
per rulings 47/57), read-only posture for supporting runs (F10-12,
`specialist-run.server.ts:2169`), review queue rows say "Review" (ruling 30).

### 3e. RBAC tiers

Roles admin|maintainer|contributor|viewer with one grant table
(`app/shared/rbac.ts`), members-only projects (R15-4), viewer credential-card
withdrawal (ruling 65). One mismatch: **FR38's "any member" vs the contributor
floor** (`rbac.ts:65`) — see the FR38 row and owner question 6.

### 3f. Operator behavior

Verified: autonomy clamp + bite-only audit (`clampAutonomy`,
`operator-actions.server.ts:197,227,380,422`), hard refuse on off/human
(:2717-2748) including the terminal-target reroute (:2599-2610),
packet-resolution → re-queue + open-packet refusal (ruling 76;
`operator-run.server.ts:151-234`), consultation disclosure appended
mechanically (`operator-toolkit.server.ts:207,236`), triage clone with
first-class `unavailable` arm (`operator-run.server.ts:801,824,889,953`),
capability-gap packets naming the grant remedy (ruling 85). The R21-9 card
("shows, not picks") verified — **but two input channels R21-9's principle
does not govern remain open**: the run-operator route still parses
backend/autonomy form overrides no UI sends (`project.task.tsx:872-890`,
committed under P11-76), and the schedule form still picks both
(`task-main-sections.tsx:434-445`). Backend has no server-side clamp analogous
to ruling 67's autonomy clamp. (APP-DRIFT AD-2 for the dead form contract;
owner questions 2 and 3.)

### 3g. GitHub delivery / merge

Verified end-to-end: R15-2 operator-decision delivery, PR adoption by head-sha
identity (ruling 35), collision-not-adoption (ruling 34), merge-pending
visibility on board and queue (ruling 40), branch-collision human packet
(ruling 50), `discard_branch` local-only deletion (ruling 77), mirror-backed
clones (ruling 87). No drift found.

### 3h. Knowledge bases, MCP, skills

Verified: KB grants by directory, repo-conventions-outrank-KB constant emitted
only with real KB text (ruling 56), reviewer KB union (3d above), Claude
native `skills:` allow-list + `settingSources` containment + `strictMcpConfig`
(`claude-runtime.server.ts:74-89,242-269,317-324`; Codex keeps prompt-text
injection, disclosed), `.claude` strip via `stripUngovernedRepoCatalog`
(`specialist-run.server.ts:2740,2761`), MCP-outside-the-matrix pinned by the
absence of any `mcp__*` deny rule (`specialist-tool-policy.ts` — zero hits),
stderr-surfacing + background warm-up for stdio MCPs (rulings 73/74/79). No
drift found.

### 3i. UX-spec components (rulings 64/66/80 follow-ups)

- **Continuity Recovery Panel: ships** (`continuity-recovery.tsx`), renders
  degraded/recovered progressions (:98,:165,:210-221); the spec's **escalated**
  and **paused-pending-review** states remain unshipped (held D10, ruling 80).
- **Board arrow-key traversal: ships** (roving tab stop, D19 markers,
  `board-page.tsx:84,176,451-517`).
- **The two R19-12 gates: SHIPPED and systematic** — whole-sheet both-theme
  contrast sweep (>400 pairs; `app.css.test.ts:1824-1836`), a
  hides-no-control-at-any-width scanner that reads the sheet's width queries
  *and* the markup they land on (:2260-2272), and a
  matchMedia-for-preferences-only gate (:2394-2399). The UX spec's ruling-66
  note ("this document does not assert their shipped state") and ruling 64's
  twin "read the tree" notes can now be closed with a dated confirmation.
- **Degraded-continuity board filter: ships** as its own chip
  (`board-filters.ts:63-65`) with a card cue (`board-page.tsx:322-324`) —
  the UX spec's "degraded continuity" default-filter ask is satisfied.
- **Skeleton loaders: still absent** (held D12); loading is pending-state based
  (`route-pending-bar.tsx`). **Execution-truth runtime-continuity fact: still
  absent from the strip** (held D11 — no continuity fact in
  `task-side-panels.tsx` / `execution-profile.tsx`; the panel and board cue
  carry it instead).
- **Ruling 91 (input_required yields)** verified on hero
  (`task-main-sections.tsx:190-203`), board top slot, and the
  "Blocked or waiting" predicate (`board-filters.ts:73-85`) — the UX spec's
  State Semantics section ("waiting on human versus waiting on agent always
  explicit"; Task Status Card state list) carries no amendment for it.

---

## 4. APP-DRIFT register (full)

| ID | What | Evidence | Why it reads as drift |
|---|---|---|---|
| AD-1 | Evidence-drop persona promised to physically read-only Codex runs | persona gate `specialist-run.server.ts:1403-1406,2015` vs sandbox gate `codex-runtime.server.ts:650-652` vs read-only posture `specialist-run.server.ts:2169` | The instruction/sandbox honesty rule (`P13-RT-02`, and `c0bc031`'s own rationale) is violated for the reviewer case; no commit or ruling acknowledges it |
| AD-2 | `run-operator` still accepts backend/autonomy form overrides no UI sends post-R21-9 | `project.task.tsx:872-890` (parse), `:899-900` (apply); pickers removed in `01daead` | A scripted POST still steers backend per run against ruling 92's "the run resolves the LIVE profile"; autonomy is clamped by ruling 67 but backend has no clamp. Leftover, not a decision — the comment block still describes the deleted pickers ("are chosen for this run", `:863-865`) |

Both are small; both sit on honesty rules this product treats as load-bearing.

---

## 5. Canon amendments needed

Ordered by how actively misleading the current text is.

1. **`architecture.md:824` — delete/replace the attachments denial.**
   "`attachments/` was specified here and never implemented; do not write to
   it" must become: attachments are canonical per-task evidence
   (`tasks/<KEY>/attachments/`, R19-19 + PRs #177/#179/#184), member-only
   served (`app/routes/task-attachment.ts`), written by evidence-granted agent
   runs, excluded from the watcher (`file-watch.service.server.ts:178`).
   Update the data-root tree (`architecture.md:799-820`) to show
   `attachments/` and `projects/<slug>/.repo-mirror/` (ruling 87), and note
   that `projects/` now contains a non-canonical cache directory. Same tree
   fix in `docs/architecture/file-formats.md:15` ("later" has arrived).
2. **decisions.md — promote the browser-implies-egress ruling** (owner ruling
   2026-08-20, commit `86c5e35`) as the next numbered ruling, and add an
   amendment marker on ruling 75(a): the mount-gate sentence stands as the
   backstop; the save/editor layer now couples the pair (grant browser ⇒
   egress flips to direct, disclosed + audited). Name the deliberate
   divergence from B-AG1's respect-the-explicit-off.
3. **prd.md — the browser + attachments capabilities need requirement-level
   text.** FR9's context-resource list should name the browser grant
   (`use-browser`, default off, egress-coupled) or an FR40 should cover
   "agents can drive a real browser and post file evidence onto the task
   thread"; FR17 should absorb the files-on-thread surface (attachments
   directory, inline rendering, PR-carried evidence references). The MVP
   feature list (prd.md:171-188) should gain the line. NFR8's amendment style
   (the ruling-39 note) is the model.
4. **ux-design-specification.md — attachments/lightbox coverage.** Mixed
   Timeline Item anatomy ("linked evidence if present") should note image
   attachments render inline on the producing comment and open an in-app
   lightbox; the Attachments panel is a real surface the spec has never named.
5. **ux-design-specification.md — Decision Packet section.** (a) Note the
   #180/#182 density/one-column redesign as the shipped visual direction (or
   promote its owner ruling to decisions.md and point at it). (b) Annotate the
   anatomy line: severity / impact summary / confidence framing were dropped
   (held D7, ruling 80) — pending owner question 5's answer.
6. **ux-design-specification.md — State Semantics + Task Status Card.** Add
   the ruling-91 amendment: while `waiting === "agent"` on an input_required
   task, the readiness pill yields to "agent working" (hero swaps, card top
   slot goes quiet, "Blocked or waiting" stops matching); blocked and
   inconsistency-risk never yield.
7. **decisions.md ruling 92 — fix the "R21-8/#183" citation** and promote the
   #183 live-deployment-display law (`withLiveAgentBackends`,
   `app/shared/mapping/task.server.ts:369`, applied in board/task/deployment
   queries) as its own ruling: display truth follows the live deployment, the
   engage-time snapshot is the fallback for undeployed profiles.
8. **prd.md FR38** — "any member assigned to the project" → "any member at
   contributor tier or above" (pending owner question 6), citing
   `rbac.ts:65,75` and the Q5 tiering.
9. **decisions.md — promote the remaining commit-only owner rulings**: #177
   (attachment rendering + link repair contract), #179 (the drop + workspace
   exception), #184 (lightbox), #186 (owner cell shows the owner; release
   lives on the Current-state row) — or record them as dated amendment notes
   where they extend existing rulings (e.g. #177/#184 extend ruling 75(d)).
10. **ux-design-specification.md ruling-66/64 notes** — add the dated
    confirmation that the two R19-12 gates (`app.css.test.ts:1824,2260,2394`),
    the Continuity Recovery Panel, and board lane traversal shipped; the
    "does not assert their shipped state / read the tree" hedges have been
    satisfiable since pass 19-21.
11. **architecture.md directory tree** — route count "26 thin route modules"
    is stale: 28 ship, including `palette-shell.tsx` (the ⌘K layout route,
    `app/routes.ts:21`) and `task-attachment.ts` (`routes.ts:52`); the
    feature-root gate tests (`copy-ban.test.ts`, `retired-vocabulary.test.tsx`,
    `toast-honesty.test.ts`) are also unlisted.
12. **ux-design-specification.md:929** — "touch targets large enough for
    tablet and mobile review flows" is a leftover from the retired
    mobile-review mode (retired 2026-07-25 in the same document); re-word to
    the desktop-first posture the rest of the spec holds.

---

## Owner questions

1. **Promote browser→egress coupling to canon — and confirm its breadth.**
   *Background:* PR #176 (`86c5e35`) made granting `use-browser` flip
   `use-web-search-fetch` to `direct` at every save layer, on your live
   instance's evidence that the contradictory pair only ever fails closed and
   confuses. This deliberately reverses the respect-the-explicit-off posture
   (B-AG1) that the delivery-headline repair follows, and ruling 75(a) still
   teaches the old polarity. Nothing in decisions.md records it. *If yes:* it
   becomes the next numbered ruling with an amendment marker on 75(a)
   (amendment C-2). *If you did not intend the auto-flip to apply on ALL
   three write paths (create, edit, deploy-from-library):* the save-layer
   repair needs narrowing before canon records it.

2. **Schedule surface: keep per-run backend/autonomy pickers?**
   *Background:* R21-9 removed the operator card's pickers because "both are
   configured on the deployed operator profile and the run resolves the LIVE
   profile" — but the schedule form one panel over still picks both
   (`task-main-sections.tsx:434-445`), and FR39 documents that ("the run
   carries the backend and autonomy level chosen at schedule time"). A
   schedule also fires unattended, arguably the case where following the live
   profile matters most. *If pickers stay:* FR39 stands and ruling 92 gets a
   scope note ("the manual run control; schedules still pin"). *If they go:*
   FR39 needs amending, schedules resolve the live profile at fire time, and
   stored pinned schedules need a migration/read rule.

3. **Tighten the run-operator route to profile-resolved backend?**
   *Background:* the route still parses `backend`/`autonomy` overrides
   (`project.task.tsx:872-890`) that no UI sends since R21-9; autonomy is
   clamped (ruling 67) but backend is not, so a hand-crafted POST runs a
   Codex-configured operator on Claude — the exact mismatch class PR #183
   fixed on the display side. *If tighten:* drop the fields (or clamp backend
   to the deployed profile) and the stale comment at :863-865 goes with them.
   *If keep:* it should be a documented escape hatch with an audit marker,
   not a leftover.

4. **AD-1: which side of the read-only evidence gap is wrong?**
   *Background:* an evidence-granted **reviewer** on Codex gets the "Posting
   files on the task thread" persona section while its read-only sandbox
   blocks the copy (`specialist-run.server.ts:1403-1406` vs
   `codex-runtime.server.ts:650-652`) — the honesty rule your own `c0bc031`
   fix states ("an exception a rule does not name is not an exception"),
   violated one layer down. *Option A:* widen read-only Codex sandboxes by
   exactly the attachments dir (evidence is arguably the reviewer's core
   output — screenshots of what it verified). *Option B:* suppress the drop
   section (and the completion pipeline's stamping) for read-only runs, so
   the persona never promises what the sandbox refuses. A reviewer posting
   visual evidence seems desirable, which argues A; B is the smaller change.

5. **The held spec-vs-app gaps (D7 / D10 / D11 / D12): build or retire?**
   *Background:* ruling 80 held four never-built UX-spec features out of pass
   20 "noted, not silently dropped", and they are still open: packet
   severity/impact/confidence anatomy fields (D7 — schema carries none),
   Continuity-Recovery-Panel escalated + paused states (D10 —
   `continuity-recovery.tsx` renders degraded/recovered only), the
   execution-truth runtime-continuity fact (D11 — the panel and board chip
   carry continuity instead), skeleton loaders (D12). Ruling 64 shows both
   dispositions are available: build (it chose build for D18/D19) or retire
   with an amendment (the R19-9 pattern). Each answer is one line in the UX
   spec either way; carrying them unanswered is what pass after pass re-files.
   D11 in particular may already be satisfied *in spirit* by the D4 board
   chip + panel — if you agree, it retires with a pointer.

6. **FR38: is the contributor floor for taking ownership the intent?**
   *Background:* FR38 says "any **member** assigned to the project can take
   or release task ownership"; code floors it at contributor
   (`rbac.ts:65`), viewers excluded, and the UI says "Any contributor or
   above can take it". FR37's amendment already says "(contributor or
   above)", so the code is almost certainly right and FR38 is the stale half
   — but FR38 carries a "revised" marker, so I am not treating my inference
   as your decision. *If the floor is intended:* amendment C-8 (one line).
   *If viewers should be able to take ownership:* that is a real RBAC change
   — an owner gains decision authority over the task (R14-2/R15-3), which a
   viewer role otherwise never holds, so it would need its own ruling.

7. **Should attachments + browser become PRD requirements (and where)?**
   *Background:* the largest capability additions since pass 19 (a real
   browser; agents posting files as evidence) are invisible in the FR list —
   a reader of the PRD alone cannot learn the product does either. Options:
   amend FR9 + FR17 in place (smallest change, keeps numbering stable) or add
   an FR40 "agent evidence capabilities" (clearer home, matches how FR37-39
   were appended). Either way the MVP feature list should gain a line. This
   is a shaping choice about the PRD's structure, so it is yours; the content
   of amendment C-3 is the same under both.

8. **Between-pass owner rulings: promote now or batch at pass close?**
   *Background:* six of the ten post-pass-21 PRs carry owner rulings that
   exist only in commit messages (table in §1). Ruling 44 requires promotion
   "before the pass closes", which technically has not failed yet — but
   ruling 84's provenance note records exactly this window being where a
   ruling id got cited by shipped code with no canon record. *If promote now:*
   pass 22 writes rulings 93+ for #176, #183's display law, and the #179 drop
   contract, and dated amendment notes for the rest (C-9's split). *If batch:*
   say which of the ten you consider rulings at all versus one-off styling
   feedback (e.g. #180/#182/#186 may be taste, not law) so canon does not
   absorb run-log entries — your own boundary from the R21-1 non-promotion.

---

*Verification depth note: every DOC-STALE/APP-DRIFT/AMBIGUOUS claim above was
verified directly against source in this worktree at HEAD `26fca45` (file:line
cited). "Aligned" rows marked at module level were confirmed to exist and be
wired but not behaviorally re-proven in this pass; the acceptance family,
browser/egress, attachments, operator-control, RBAC and packet claims were all
read at the enforcement point.*
