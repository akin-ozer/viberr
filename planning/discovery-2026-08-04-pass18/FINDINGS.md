# Pass 18 — findings & implementation backlog

Authoritative backlog for the Phase-D implementation. Sources: live testing this
pass (`NOTES.md`), the pass-17 reference docs (still the accurate current-state
baseline — the tree is unchanged since merge `934ede6`), and the owner rulings
R18-1..R18-4 gathered mid-pass. Every item has a disposition; nothing is deferred.

Repo under test for the PR flow: `github.com/akin-ozer/viberr` (Viberr itself),
project **Viberr** (VIB). Non-PR experiments used **Pass 18 Lab** (LAB).

---

## Owner rulings (binding — gathered 2026-08-04, pass 18)

- **R18-1 — a reviewer auto-inherits the task's delivering KBs.** When a
  specialist is engaged as a reviewer on a task, it loads the knowledge-base
  grants the delivering engagement used for THAT task (union with its own
  profile grants), so deliverer and reviewer judge against the same conventions.
  Resolves **F18-11** (reviewer flagged a KB-required footer as unsubstantiated
  because it lacked the KB grant → false request_changes). Per-profile grants
  stay the base; the task's delivering-KB set is added at reviewer-run time.
- **R18-2 — a delivery re-queues the operator under full autonomy.** After the
  server opens a review PR, re-trigger the queued operator (at minimum when the
  task's operator autonomy is `full`) so it proceeds to engage the reviewer /
  recommend the next step without a human nudge. Delivery is not a stage
  transition, so the existing chain-retrigger never fired — the fix restores the
  "never strand `waiting:human` with no packet" invariant (R-A) to the
  post-delivery moment. Resolves **F18-10**.
- **R18-3 — the SDK-native skill/command catalog is governed OUT.** A spawned
  agent run must load ONLY Viberr's granted skills. Strip the `.claude`
  directory from every per-task workspace clone (so the cloned repo's own
  commands don't ride along) and pass the CLI the flags that suppress the
  user-level catalog. Resolves **F18-8**; closes the same host-leak class the
  pass-13 CODEX_HOME isolation addressed, now for the Claude side + repo side.
- **R18-4 — branch-collision stays a human-gated packet.** Do NOT force-reset
  the remote task branch at execution start. The collision packet + human
  resolve is an intentional safety checkpoint against clobbering unrelated
  remote history. Closes the carried **F17-L4 (behavior)** owner question as
  "keep the packet". (The copy split from pass 17 stays; only the "always
  reset" option is rejected.)

Prior rulings still in force: R17-1..R17-5, R16-1..R16-7, R15-x, R6-2, the
members-only + ALWAYS_HUMAN + store-path rulings.

---

## A. Correctness / governance (implement first, with tests)

- **F18-5 (HIGH, live-caught) — the data-root writer lock fails OPEN when the
  lock file is deleted/replaced mid-hold; reproduced a real WAL-clobber.**
  Sequence observed live: host dev server acquired `state/writer.lock`; a store
  reset then DELETED the lock out from under the live holder; the container
  booted, found no file, acquired fresh — two writers on one `docker-data` root
  over VirtioFS. Org-level SQLite tables (users, the encrypted PAT, org KB/MCP
  rows, 20 notifications) were silently LOST on the next boot; `PRAGMA
  integrity_check` passed both before and after (it does not detect lost
  transactions). The B-FD1 lock (`data-root-lock.server.ts`) has no defense
  against its own file being removed: the holder keeps a deleted-inode fd and
  never re-verifies it still owns THE lock. Fix: (a) the holder periodically (or
  before each governed write batch) re-verifies its lock file's inode via
  `fstat` on its held fd vs `stat` of the path — on mismatch/absence it LOUDLY
  shuts down (fail closed) rather than continuing lock-less; (b) surface the
  lock holder's identity on the Home store-maintenance strip so a human can SEE
  who owns the root; (c) `deployment.md` gains a note that wiping `state/` while
  any process runs defeats B-FD1, plus the `::1`(host) vs IPv4(docker-proxy)
  same-port split-brain. Tests: an injected inode-changed probe triggers the
  loud shutdown; a normal hold does not.
  Files: [data-root-lock.server.ts](app/server/db/data-root-lock.server.ts),
  [boot.server.ts](app/server/boot.server.ts).

- **F18-6 (HIGH, UX dead-end) — ghost-admin removal deadlock.** When a
  project's only admin-role member is a DELETED org account (what a user-table
  loss or account removal produces): Settings→Members' "remove this stale
  membership" X returns 409 "…is the only admin — assign another admin in
  Policy first" (the last-admin guard counts a REMOVED account as a protected
  admin); Policy→Human access renders the ghost's role picker read-only saying
  "remove it in Settings → Members" (CIRCULAR); role changes need project-admin
  which only the ghost holds. Recoverable only by hand-editing `project.md`.
  Fix: (1) the last-admin guard counts ACTIVE members only, so a ghost admin is
  removable; (2) org admins may remove a ghost membership regardless of the
  last-admin rule (org-admin override already exists — extend it here); (3)
  render the 409 refusal reason inline near the row, not only as a
  backgrounded-throttled toast (R15-11: refusals are rendered copy in place);
  (4) reconcile the two surfaces' circular pointers. Also verified: joining an
  org-admin as a Viewer member DOWNGRADED their effective authority (the
  org-admin override pill disappeared) — confirm the org-admin override still
  applies to a member org-admin, or document why membership narrows it.
  Files: `removeMember`/last-admin guard in
  [org.settings.tsx](app/routes/org.settings.tsx) + members panel + the Policy
  human-access surface. Tests: ghost-only-admin removal succeeds; refusal
  renders inline.

- **F18-10 / R18-2 (governance) — full-autonomy strands after delivery.** After
  the server opens the review PR, nothing re-queues the operator (delivery isn't
  a transition), so an autonomous task sits `waiting:human` with empty
  `recommendations`, no packet, no card. Fix per R18-2: re-trigger the queued
  operator after a successful delivery when autonomy is `full`. Tests: a
  full-autonomy delivery enqueues a follow-up operator run; a supervised one
  leaves a visible recommendation (or at least does not silently strand).
  Files: `performDelivery` / delivery reconcile in
  [workspace-delivery.server.ts](app/server/github/workspace-delivery.server.ts)
  + the operator re-trigger seam.

- **F18-11 / R18-1 (governance) — reviewer auto-inherits the task's KBs.** A
  reviewer with `kb: []` reviewed against different conventions than the
  deliverer used and returned a false `request_changes` on a KB-compliant
  footer. Fix per R18-1: at reviewer-run context assembly, union the reviewer
  profile's KB grants with the KB set the delivering engagement used for this
  task. Tests: a reviewer run on a task whose deliverer used KB X loads KB X's
  bodies even when the reviewer profile grants none; a task with no delivering
  KBs is unchanged.
  Files: reviewer branch of
  [specialist-run.server.ts](app/server/tasks/specialist-run.server.ts)
  (kb resolution ~`:688`, `:1143`), KB read in
  [kb-injection.server.ts](app/server/files/kb-injection.server.ts).

- **F18-8 / R18-3 (governance) — strip the ungoverned SDK catalog.** Spawned
  runs load user-level + repo-level `.claude` commands on top of granted skills.
  Fix per R18-3: strip `.claude` from each per-task workspace clone before the
  run, and pass the CLI the flags suppressing the user-level catalog, so only
  Viberr-granted skills reach the run. Tests: a workspace clone has no `.claude`
  at run start; the run's init tool/command list contains no ungranted
  slash-commands. Files: workspace clone setup + the Claude/Codex runtime
  adapter launch args ([claude-runtime.server.ts](app/server/runtimes/claude-runtime.server.ts),
  [codex-runtime.server.ts](app/server/runtimes/codex-runtime.server.ts)).

- **F18-13 (bug, honesty) — a Done task still offers Force accept +
  "Acceptance is blocked".** `GithubSidePanel` renders `forceAcceptRow` whenever
  `forceAcceptReason && onForceAccept`, with no terminal-stage guard; force
  accept BYPASSES (never satisfies) the verdict gate, so `task.blockReason`
  persists after Done and the card keeps offering to force-accept an
  already-accepted task. Fix: suppress the force-accept row + acceptance-blocked
  hint once the task is terminal (stage === done / pr accepted-or-merged) —
  R16-3 precedent. Test: a Done task renders no force-accept control.
  File: [task-side-panels.tsx:53-77](app/features/task-detail/task-side-panels.tsx).

## B. UX / honesty

- **F18-1 — orphaned notifications + shell-less/theme-less error boundary.**
  After the owner deleted the pass-17 project dirs, 20 notifications referencing
  deleted tasks/PRs survived: they count toward the bell badge and clicking one
  navigates to a `/projects/<slug>/tasks/<KEY>` that 404s. Worse, that error
  page renders WITHOUT the app shell and (on the project route) in LIGHT theme
  while the app is dark; the root route's 404 keeps dark but is still shell-less
  and shows a raw `Error: No route matches URL`. Fix: (a) at rebuild/read time,
  a notification whose subject entities no longer resolve renders disabled with
  "this task no longer exists" copy and is auto-read / dropped from the unread
  count (soft-ref precedent, ruling 9); (b) the route error boundaries keep the
  shell + the viewer's theme, and the project-not-found copy is friendly, not a
  raw router string. Files: notification projection/meta
  ([notification.server.ts](app/shared/mapping/notification.server.ts),
  [notification-item.tsx](app/features/notifications/notification-item.tsx)),
  route ErrorBoundary(ies) in [root.tsx](app/root.tsx) /
  [project.tsx](app/routes/project.tsx).

- **F18-3 (honesty) — OAuth affordances ignore the provider-configured fact
  (R17-4 generalization).** On a no-OAuth deployment: Profile→GitHub identity
  renders warn-toned `read:user`/`user:email` scope chips + a "Connect" whose
  only outcome is the error band "GitHub sign-in couldn't start"; the org
  Allow-access modal DEFAULTS to the GitHub method and promises "allowed the
  moment they sign in with GitHub" — a promise the deployment cannot keep. Fix
  as ONE rule mirroring R17-4: surfaces offering an OAuth affordance key off the
  configured-providers fact — collapse/reorder to a quiet one-liner and don't
  default to an unusable method when no provider is configured. Files: profile
  GitHub-identity card ([profile route/feature]), Allow-access modal in
  [org.settings.tsx] / [users-panel.tsx](app/features/org-settings/users-panel.tsx).

- **F18-4 (minor, honesty) — KB row can't tell "empty" from "folder missing".**
  A KB whose store folder does not exist reads "0 docs · agents read the live
  folder · re-scanned Nh ago" — identical to a healthy empty KB, with a stale
  re-scan claim. Fix: a "folder missing" note (mirrors the D8/credUnreadable
  honesty precedent). File: KB resource row in
  [resource-rows.tsx](app/features/org-settings/resource-rows.tsx).

- **F18-1b (low) — reconcile could stamp a superseded packet.** During the
  reopen-detection window (F17-L4 reopen test), the stale closed-PR recovery
  packet card renders beside a GitHub card already showing "in review" for ~50s
  until the operator withdraws it. Low: the reconciler could mark the packet
  `superseded` immediately (R16-3 spirit) instead of leaving it for the operator
  tick. Optional; note if not done.

- **F18-7 (minor, copy) — apply-recommendation 409 conflates unknown-id with
  resolved.** `applyRecommendation` throws "That recommendation was already
  resolved." both when the id is unknown AND when it was resolved. Minor: the
  two cases could read apart, or the message could hedge ("no longer
  available"). File: [task-actions.server.ts:5387](app/server/tasks/task-actions.server.ts).

- **F18-9 — CLOSED 2026-08-05 as NOT REPRODUCIBLE (owner ruling).** ~~new
  agent-profile modal defaults ALL org skills to ON~~. The claim was that
  creating a profile pre-selects every org skill, contradicting the
  deliberate-grant model. The pass-18 gap analysis could not reproduce it: BOTH
  profile modals initialise a new profile with **empty** grants and say so —
  `create-profile-modal.tsx:806-812` and `agent-template-modal.tsx:123-131`.
  Put to the owner with that contradicting evidence; ruling: **close it as not
  reproducible.** No default was changed — the correct outcome, since acting on
  the original note would have *introduced* the very over-granting it feared.
  Kept as a record of the class: a finding recorded from a UI impression and
  never re-verified in code can survive several passes as though it were fact.

## C. Verified-working this pass (do NOT re-open — evidence in NOTES §Phase B)

Operator auto-advance + role-correct specialist pick (incl. routing VIB-4 to the
new Docs-Writer over Developer); F17-L8 confirm-echoes-selection + F17-L3
prefill-chosen-deliverable (both pass-17 fixes re-verified live); server-owned
delivery + operator PR-open attribution (F17-1 clean); revision-bound reviewer
verdict incl. a REAL organic `request_changes` that correctly blocked an
autonomous self-accept (verdict gate holds at full autonomy); R15-3
apply-recommendation; R17-1 revision-drift surfaced at accept (rose MERGE-HEAD
row); accept→human-merge + R15-6 branch cleanup; force-accept honesty
(merged-PR + awaiting-verdict + audited); R16-1 out-of-band merge NOT
auto-advanced (R8-6 divergence note + recommendation, stage unchanged); ruling-17
recovery packet with reopen-detection (auto-withdraw); F17-L4 both copy variants
(merged #127 vs closed #128); injection guardrail (Codex refused a
credential-exfiltration injection, artifact clean); R15-14 ask-human resolution
resumes the ASKING agent (developer), not the operator; FR39 scheduled re-run
persisted canonical + R14-3/RV-03 archive cancels it (firedAt null); MCP parity
(Claude hyphenated `mcp__everything-http__*` 16 tools + capability-gated
`viberr_agent`; Codex echo call); KB grounding reached the deliverer (SPICEBERRY
footer); skills load per grant (only `smoke-note-style` injected, decoy
`release-announcements` did NOT leak — but see F18-8 for the SDK-native channel);
R17-4 local-first login live; F17-L11 first-login "temporary password" copy;
member-scoped home + ⌘K visibility scoping (Mira couldn't see LAB); contributor
RBAC (no force-accept/archive, correct perms copy); Done-task commentable (R7-6);
Lexical @mention menu; light theme clean (no contrast bugs); mobile task-detail
reflow (except F18-12).

## D. Responsive

- **F18-12 (responsive defect) — Execution-profile grid clips governance
  controls on mobile.** At 375px `.profile-grid` computes two FIXED ~230px
  columns (`overflow-x: visible`, no scroll) inside a 281px container, so the
  DELIVERING AGENT ("Run") and HUMAN OWNER ("Manage"/"Assign me") column is
  rendered off the right edge and unreachable; REVIEWING AGENTS "Run"/"×" is
  half-clipped. Violates `ux-design-specification.md:870` ("Every action …
  renders at every width"). Fix: the profile-grid collapses to one column below
  ~640px. File: `.profile-grid` in [app.css](app/app.css) + the execution-profile
  layout in [task-detail]. Test: a jsdom/CSS assertion or an e2e at 375px that
  the delivering + owner controls are in-viewport.

## STATUS — Phase D complete (all committed on `pass18/product-fixes`, 2845 tests + tsc green)

Every item above is IMPLEMENTED, tested (each fix canary-verified by neutering it and
watching the test fail), and — where browser-observable — live-verified. Commit map:

| Finding / ruling | Commit | Live-verified |
|---|---|---|
| F18-13 (Done task withdraws force-accept) | `7abb286` | ✓ VIB-3 Done: no force-accept / no "blocked" |
| R18-1/F18-11 (reviewer inherits deliverer KBs) | `97131bd` | unit (organic repro in Phase B) |
| F18-5 (writer lock fails closed) + F18-5b (Home strip) | `8d75181`, `23c9ce6` | ✓ Home strip "Writer: pid … on …" |
| R18-3/F18-8 (strip repo `.claude` + strict MCP) | `e274134` | ✓ VIB-6 run init (below) |
| R18-2/F18-10 (full-autonomy re-queue) | `e07abc0` | unit (LAB-1 strand repro in Phase B) |
| F18-6 (ghost-admin removable) | `643ca81` | file-recovery repro in Phase B |
| F18-4 (KB folder missing) | `7b8696c` | ✓ moved folder → "folder missing" |
| F18-12 (profile-grid stacks on mobile) | `4147036` | ✓ 375px single column, controls reachable |
| F18-7 (apply-rec 409 copy) | `4147036` | unit |
| F18-3 (OAuth affordances by provider) | `20c2785` | ✓ profile quiet one-liner; modal defaults Local |
| F18-1 (orphaned notifications) | `5e67127` | ✓ project-orphan excluded; task-404 in-shell |
| Docs canon (R18-1..4 + F18-5 deployment) | `a9fd7ba` | — |

**Deliberately NOT changed (recorded, not deferred):**
- **F18-9** (agent-modal all-skills-on default) — left as an observation per its own
  disposition; changing the create-time default needs an explicit owner ruling.
- **R18-4/F17-L4** — a KEEP ruling (do NOT force-reset the branch); no code change is correct.
- **F18-1b** (reconcile stamps the recovery packet `superseded` instantly) — explicitly
  optional ("note if not done"); the reconciler withdraws moot *recommendations* but the
  closed-PR *packet* still clears on the next operator tick. Low; left for a future pass.

**Disposition audit (opus subagent, independent re-derivation from the tree):** all 13
CONFIRMED with real passing tests; the two things it surfaced (F18-5 holder was only on
`/resources/health`, and F18-12 had no responsive unit test) were addressed — the Home
strip surface was added (`23c9ce6`, F18-5b) and F18-12 was live-verified at 375px.

## E. Docs-canon (R17-3 continued) — pass-18 additions

- Promote R18-1..R18-4 into
  [docs/architecture/decisions.md](docs/architecture/decisions.md) as the next
  numbered rulings (it ended at 46 / R17-5 after pass 17), keeping the citation
  scheme code comments will use.
- `deployment.md`: add the F18-5 operational notes (never wipe `state/` while a
  process runs; the same-port `::1`-vs-IPv4 dual-listener trap).
- Re-read the four operational docs at pass close (the required R17-3 step).
