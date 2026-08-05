# Pass 18 — running discovery notes (2026-08-04, evening)

Working state: main @ 934ede6 (pass-17 merge). Container `viberr-app-1` serves a
fresh image built post-merge on :5173, data root `docker-data` (container is the
ONE writer — no host dev server while it runs). Store state at pass start: the
owner deleted `docker-data/projects/*` (empty playground), org-level sqlite data
survived — 3 users (Arda admin + 2 members), 1 GitHub connection (akin-ozer),
1 KB, 1 MCP server, 3 skills, 2 agent profiles + operator. Login:
arda@viberr.dev / viberr-dev-2828.

Reference docs: `planning/discovery-2026-08-04-pass17/` (7 current-state docs,
re-derived from this exact tree — treat as baseline; this pass records DELTA +
new findings only).

## Findings (running, F18-x)

- **F18-1 — orphaned notifications + shell-less 404.** After the owner deleted
  the pass-17 project dirs (a legitimate operation in a file-canonical store),
  20 notifications referencing VIB-8/VIB-9/PR#132/#133 survive: (a) they count
  toward the bell badge; (b) clicking one navigates to
  `/projects/viberr/tasks/VIB-9` → "Page not found / No project at
  projects/viberr"; (c) that error page renders WITHOUT the app shell and in
  LIGHT theme while the app is dark — the error boundary drops both shell and
  theme. Candidate fixes: prune/tombstone notifications whose subject entities
  no longer resolve at rebuild time (or render them disabled with "project no
  longer exists" copy + auto-read), and make the route error boundary keep
  shell + theme. Severity: medium (badge noise + jarring dead-end).
  Evidence: screenshots in transcript, 2026-08-04 ~21:2x.

- **F18-2 (a11y, to verify) notification items have no accessible name.** In the
  bell popup the per-item buttons read as unnamed `button` in the AX tree
  (title/body are likely visual-only children not exposed as the accessible
  name — verify against markup; if the text is inside the button it should have
  a name, so the empty name suggests aria-hidden content or structure issue).

- **F18-1c refinement:** the theme loss is scoped to the PROJECT error boundary
  (`/projects/viberr/tasks/VIB-9` 404 → light, shell-less) while the ROOT
  boundary keeps dark (`/prefs` 404 → dark, still shell-less, raw
  `Error: No route matches URL "/prefs"` copy). Two error surfaces, two voices,
  neither keeps the shell.

- **F18-3 — profile OAuth card ignores the R17-4 fact.** On a deployment with
  NO OAuth provider configured, Profile → GitHub identity renders warn-toned
  `read:user`/`user:email` scope chips and a "Connect" button whose only
  possible outcome is the error band "GitHub sign-in couldn't start — it may
  not be configured on this deployment." The login page (R17-4) collapses
  unconfigured providers to a footnote; this surface should key off the same
  provider-configured fact (quiet one-liner instead of chips+CTA). R15-11
  adjacent (control naming an outcome its surface can't promise).

- **F18-4 (minor, honesty) KB row can't tell "empty" from "missing".** The
  seeded "Viberr Conventions" KB points at `store://kb/viberr-conventions/`;
  the folder does not exist on disk (owner wiped it), and the row reads
  "0 docs · agents read the live folder re-scanned 4h ago" — identical to a
  healthy empty KB, plus a stale "re-scanned" claim from before the wipe.
  Candidate: a "folder missing" note (mirrors credUnreadable honesty precedent).

- Observations (fine as-is): connections tab honest unproven-scope copy;
  users tab "setup pending" pill; notifications page "Waiting on you"
  correctly live-derived at 0 while orphaned rows persist; profile page
  notification routing/appearance/password all coherent; resources footer
  explains global-vs-project split well.

- **F18-5 (HIGH, live-caught) — the writer lock fails open in the dev+container
  race; two writers were live on docker-data.** Observed 2026-08-04 21:1x:
  host `react-router dev` started 21:10:52 listening on `[::1]:5173` with
  `VIBERR_DATA_ROOT=docker-data`; container `viberr-app-1` started 21:11:53,
  docker-proxy on `*:5173` (IPv4); macOS resolves localhost→::1 first so the
  browser hit the HOST process while the container also ran against the SAME
  root. `state/writer.lock` read `{pid:1, hostname:"viberr", startedAt:
  18:11:54Z}` (the container) while the HOST process happily created the VIB
  project files and WAL commits — the B-FD1 rule ("a lock from a DIFFERENT
  host is refused") did not stop either process. Both wrote the same
  projection.sqlite over VirtioFS — the exact documented WAL-clobber
  catastrophe ([[docker-data-dual-writer-hazard]]). ROOT CAUSE (established
  via lsof): the host dev server ACQUIRED the lock legitimately at ~21:11; the
  owner's store reset then DELETED `state/writer.lock` out from under the live
  holder; the container booted at 21:11:53, found no file, and acquired fresh.
  The design has NO defense against the lock file being removed/replaced
  mid-hold — the holder keeps a deleted-inode fd and never re-verifies
  (fstat-vs-stat inode compare) that its lock is still THE lock. Additionally
  `docker compose stop` released the container's lock while the host process
  kept serving lock-less. Hardening candidates: (a) periodic or per-write
  inode re-verification → loud shutdown when stolen; (b) surface holder
  identity on the home maintenance strip so a human can SEE who owns the
  root; (c) document that wiping `state/` while any process runs defeats
  B-FD1. The ::1(host)-vs-IPv4(docker-proxy) split on one port made two live
  servers look like one app — deployment-doc note. Repro evidence: lsof both
  listeners; deleted-inode lock fd on pid 30797; lock content pid:1/viberr
  while the host wrote files; toast showing host path while compose sets
  `/data`. Integrity check after stopping the container: ok (no corruption
  this time). Session recovery: killed the orphaned dev server, restarted via
  launch.json (pid 34454 holds a fresh lock; container stays stopped).
  **UPDATE — CORRUPTION CONFIRMED, severity CRITICAL:** on the fresh boot the
  org-level tables came up EMPTY — users (re-seeded to 1 admin), the akin-ozer
  github_connection (encrypted PAT lost), org KB row, org MCP row, all 20
  notifications. `PRAGMA integrity_check` passed both before and after —
  integrity_check does NOT protect against lost transactions from dual-WAL
  clobbering; the loss was silent. The VIB project survived (file-canonical),
  now referencing a connection id that no longer exists (its own honesty test,
  see walk log). This is the strongest possible argument for the hardening
  fix: the lock must fail CLOSED against file deletion, and the July incident
  class reproduced under observation within ~20 minutes of dual-writer state.

- **F18-6 (HIGH, UX dead-end) — ghost-admin removal deadlock.** When a project's
  only admin-role member is a DELETED org account (exactly what a user-table
  loss or account removal produces): (1) Settings → Members renders the stale
  row with "remove this stale membership" + an X, but the action 409s with
  "…is the only admin — assign another admin in Policy first" — the
  last-admin guard counts a REMOVED account as a protected admin; (2) Policy →
  Human access renders the ghost's role picker read-only and says "remove it
  in Settings → Members" — CIRCULAR; (3) role changes need project-admin,
  which only the ghost holds; (4) org-admin override does NOT apply once the
  org admin joins as a member (joining as Viewer DOWNGRADED my effective
  authority — the override pill disappeared), and the Policy pickers stay
  disabled for non-member org admins?? (to verify — I only tried after
  joining). Recovery was possible ONLY by hand-editing project.md (watcher
  reprojected live, verified in sqlite). Also: all four failed remove attempts
  produced NO visible error in the pane (probably the backgrounded-pane toast
  throttling, but the 409 reason deserves in-place rendering near the row,
  not a transient toast — refusals are rendered copy in place per R15-11).
  Fixes: last-admin guard counts ACTIVE members only; ghost-membership removal
  allowed for org admins regardless; refusal rendered inline; reconcile the
  two surfaces' circular pointers.

- **F18-8 (governance, needs owner ruling) — the SDK-native skill/command
  catalog is ungoverned.** VIB-4's Docs Writer (Claude) init line shows
  `slash_commands` including the HOST user's skills (deep-research,
  design-sync, dataviz, claude-api, goal, team-onboarding — none granted in
  Viberr) plus the workspace clone's own repo-level `.claude` commands
  (verify, debug, code-review, batch …). Viberr's grant system governs ITS
  skill-injection channel (only smoke-note-style was injected), but the
  Claude CLI's native catalog loads user-level + repo-level commands
  regardless — an ungoverned context/behavior channel. On the production
  container the user-level half collapses (empty home) but the REPO half
  (.claude in the cloned repo) rides along everywhere. Related precedent:
  pass-13 "Codex inherited HOST skills+MCP" (fixed via CODEX_HOME isolation);
  R16-5 ruled granting an MCP server IS the grant — but nobody grants the
  repo catalog. Options: (a) point CLAUDE_CONFIG_DIR isolation harder +
  --strict-mcp-config-style flags to suppress user catalog; (b) accept &
  document as R16-5-adjacent ("the repo's own .claude is part of the repo");
  (c) strip .claude from workspace clones. Evidence: run_Gum2jAa-kPIf init.
  ALSO verified there: Claude MCP parity (hyphenated tool ids,
  mcp__everything-http__echo, both servers "connected") and the
  capability-gated viberr_agent toolkit (ask_human + post_comment only).

- **F18-11 (product/coherence, owner question) — reviewer/deliverer KB-grant
  asymmetry makes agents disagree about conventions.** Discovered ORGANICALLY
  on LAB-1 (full-autonomy). The Developer had the `pass-18-conventions` KB
  granted, so it correctly wrote the required "Verified under the SPICEBERRY
  protocol." footer. The Reviewer profile has `kb: []` (no grant), so from its
  context the footer is an unexplained/unsubstantiated line → it returned
  **request_changes** against work that IS compliant with the convention the
  DELIVERER was told to follow. The developer then hit a genuine convention
  conflict ("the KB requires the footer, the reviewer wants it removed") and
  raised an ask-human packet; the full-autonomy operator investigated,
  confirmed the convention isn't visible repo-side, and correctly LEFT IT FOR
  A HUMAN rather than forcing through (verdict gate + doubt-injection working
  at full autonomy — a real positive). But the root cause is a coherence gap:
  a task's reviewer reviews against a DIFFERENT knowledge base than its
  deliverer used, so shared conventions produce false review failures. Owner
  question: should a task's engaged reviewer automatically inherit the KB
  grants the delivering engagement used for THAT task (so both judge against
  the same conventions), or is per-profile isolation intended and the fix is
  operational (grant shared convention KBs to every profile that touches the
  task)? This ALSO doubles as live proof the verdict gate holds under full
  autonomy (a request_changes stopped an autonomous self-accept) and that KB
  grounding reached the deliverer.

- **F18-12 (responsive defect, violates the responsive ruling) — Execution
  profile grid clips governance controls on mobile.** On the task detail at
  375px, `.profile-grid` computes `grid-template-columns: 232.9px 224.4px`
  (two FIXED columns ≈457px) inside a 281px container with
  `overflow-x: visible` — and neither `.panel` nor `.detail-main` provides a
  scroll affordance. Result: the entire RIGHT column — DELIVERING AGENT (its
  "Run" button) and HUMAN OWNER (its "Manage" / "Assign me") — is rendered
  off the right viewport edge and is unreachable; the REVIEWING AGENTS panel's
  "Run"/"×" is half-clipped too. This violates
  `ux-design-specification.md:870` ("Every action, including destructive and
  governance actions, renders at every width"). The OPERATOR/REVIEWING column
  (left) is fine; only the right column is lost. Fix: the profile-grid must
  collapse to one column below ~640px (like the rest of the detail reflows).
  Evidence: computed styles above; mobile screenshot in transcript. (The rest
  of the mobile task detail reflows correctly — shell→hamburger, pills wrap,
  store path + goal + timeline all fine.)

- **F18-13 (bug, correctness/honesty) — Done task still offers "Force accept"
  + "Acceptance is blocked".** After VIB-3 was force-accepted to Done (bypassing
  the missing verdict), its GitHub side-card STILL renders "Acceptance is
  blocked: This task's latest review requests changes… rework and re-review
  before accepting." AND a live "Force accept (override review gate)" button —
  on a task whose Stage is Done, Waiting-on Nothing. Verified on a fresh
  reload (not a stale render). Root cause: `GithubSidePanel` in
  [task-side-panels.tsx:53-77](app/features/task-detail/task-side-panels.tsx)
  computes `forceAcceptReason = task.blockReason ?? (open blocked packet…)`
  and renders `forceAcceptRow` whenever `forceAcceptReason && onForceAccept`,
  with NO terminal-stage guard. Force-accept BYPASSES the verdict gate (never
  satisfies it), so `task.blockReason` persists after Done, and admins keep
  `onForceAccept` — the card keeps offering to force-accept an
  already-accepted task. Fix: suppress `forceAcceptRow` (and the acceptance-
  blocked hint) once the task is terminal (stage === done / pr accepted-or-
  merged). R16-3 precedent (hide force-accept while the PR is closed) — same
  class: the affordance must reflect that there's nothing left to accept.
  Also note VIB-3 shows a "validation failing" pill on a Done task, which is
  honest (it WAS force-accepted past a failing/absent verdict) — leave that.

## Carried over from pass 17 (still open)

- **F17-L4 (behavior) owner question:** delivery blocking on stale remote task
  branches is timing-dependent; the candidate fix is "always force-reset the
  remote task branch to base at execution start". Needs an owner ruling this
  pass.
- **F17-2 (low):** task "Waiting on: Human decision" — tooltip added in pass 17
  per USE-CASES #9; confirm it actually shipped, else re-open.
- **UI rough edges (UI-INVENTORY §0.2):** run-log stream disconnect story;
  drag-result live-region announcements; Icon innerHTML (low risk, confirm).

## Session ledger (post-corruption rebuild)

- Users: arda@viberr.dev / viberr-dev-2828 (Admin); mira@viberr.dev temp
  5k31lgeNIecR (Member, setup pending); deniz@viberr.dev temp XfQjrfDdCouR
  (Member, setup pending). Connection: akin-ozer re-created from `gh auth
  token` via the connection-add form action (classic token → scopes PROVEN
  immediately from x-oauth-scopes: "Confirmed against the token",
  pull_request:write "(implied by `repo`)" — a nice honesty split vs the
  fine-grained "unproven until attached" path pass 17 recorded).
- Projects: Viberr (VIB, Balanced, akin-ozer/viberr) created pre-corruption;
  survived file-canonically; its member row references the EATEN arda user id
  (ghost member; current arda is a non-member org admin → topbar shows the
  "org-admin override" pill — R7-1 surface, organically exercised).
- Dev server: launch.json viberr-dev (pid 34454) on :5173 against docker-data,
  container stopped. MCP everything server restarted on :3001 (background task
  blo8cahty).

## F18-3 extension (systemic)

The provider-configured fact (R17-4) is honored by login only. On a no-OAuth
deployment: (a) Profile → GitHub identity renders warn scope chips + a
Connect that can only fail; (b) Allow access modal DEFAULTS to the GitHub
method and promises "allowed the moment they sign in with GitHub" — a promise
this deployment cannot keep (a whitelisted GitHub user can never sign in).
Fix as one rule: surfaces offering an OAuth affordance key off configured
providers (collapse/reorder + honest copy), mirroring R17-4.

## Phase B use-case plan (UC18-x; ✓ = executed)

Setup/identity: UC18-1 ✓ VIB creation via modal (Balanced); UC18-2 ✓ LAB via
index action (auto policy; creator-admin pinned); UC18-3 ✓ connection re-add,
classic-token scopes proven instantly; UC18-4 ✓ Allow-access local × 2 (temp
passwords); UC18-5 ✓ ghost-member deadlock (F18-6) + file-canonical recovery +
live watcher reprojection; UC18-6 ✓ set-credential × 2 projects.

Lifecycle on VIB (PR-producing, qa/smoke/pass18-* only): UC18-7 first-task
creation + scoping packet + R15-10 empty-board teach; UC18-8 packet resolve
(F17-L3/L8 regressions); UC18-9 Developer(Codex) run → auto-advance → server
delivery → PR + operator attribution (F17-1); UC18-10 Reviewer(Claude)
verdict gates acceptance; UC18-11 accept → human merge + branch cleanup ON;
UC18-12 gh-close → recovery packet → archive+deleteBranch; UC18-13 gh-close
then gh-REOPEN → packet auto-withdrawn (copy's promise); UC18-14 no-diff →
"Completed — no changes" (R17-2 live); UC18-15 revision drift surfaced at
accept (R17-1 live); UC18-16 force-accept visibility by role + audited use;
UC18-17 LAB full-autonomy self-accept → merge-pending → Complete merge.

Agents/resources: UC18-18 in-app KB authoring + canary grounding + re-index;
UC18-19 MCP register/health/grant → Claude AND Codex mount parity; UC18-20
new agent profile (model/effort catalog, stage eligibility R14-1) + operator
selection; UC18-21 new skill granted/loaded vs ungranted absent; UC18-22
injection guardrail on Codex + ask-human resume (R15-14); UC18-23 mention on
Done task → conversational reply (R7-6, NEW-4); UC18-24 scheduled re-run
fires + archive cancels (FR39/R14-3); UC18-25 owner take/release (FR38);
UC18-26 ⌘K visibility scoping (Mira not in LAB); UC18-27 notification pref
gating; UC18-28 session export; UC18-29 mobile 375px task detail + accept;
UC18-30 light-theme task detail + GitHub.

## Phase B execution log (running)

- **UC18-7 ✓** VIB-1 created via modal; goal passed triage gate (no packet
  needed — operator advanced Triage→Ready→In Progress, deployed Developer
  (Codex), auto boundaries logged as Transition requests). Operator runtime =
  claude-agent-sdk on sonnet; run cost surfaced ($0.06 · 5 turns · 31s).
- **UC18-8 ✓ (both fixes verified live)** VIB-2's vague goal → "input
  required" at creation + operator scoping packet with REAL repo analysis
  (obs rows for docs/testing.md + qa/smoke/*). F17-L8: confirm button
  aria-label echoed BOTH the default pick and my changed selection. F17-L3:
  resolving with option 2 opened the goal editor PREFILLED with the chosen
  deliverable. Saved → operator advanced to impl and dispatched Codex.
- **UC18-9 ✓ + organic collision** VIB-1 Developer committed; delivery hit
  the STALE vib-1 branch (pass-17 PR #126 merged) → operator blocked packet
  with 3 typed options + operator-pick chip + note field; resolved in-app →
  operator deleted the stale branch (ruling 17 path), pushed, opened PR #135
  (1 commit, 1 file — clean). Policy-engine timeline note carries the
  F17-L4 merged-copy split. PR-open event attributed to Operator (F17-1
  regression clean).
- **UC18-10 ✓** Engaged Reviewer (Claude sonnet) via Execution profile; run
  produced a revision-bound verdict (result: approve, headSha == delivered
  revision) recorded in task.md verdicts[].
- **R15-3 ✓** Operator posted "Move the task to Review" recommendation with
  evidence; my Apply click moved the stage; review-queue count updated;
  transition re-triggered the queued operator (R-A).
- **UC18-11 ✓** Accept dialog named PR #135→main, revision, healthy verdict
  (no drift row when head matches — correct absence); Accept → Done & merge →
  PR MERGED (19:07Z), vib-1 branch auto-deleted (R15-6 ON), task Done ·
  merged, execution profile "task closed", reviewer panel "no new reviewer
  engagements".
- **UC18-12 (variant) ✓** VIB-2 delivery hit the vib-2 stale branch (pass-17
  had BOTH closed #124 and merged #127 — packet body used the merged-PR copy,
  correctly naming #127 unrelated). Resolved the OTHER path: deleted the
  stale branch externally via gh, then confirmed option 0 with a note via the
  resolve-packet action.
- **UC18-18 partial ✓** KB "Pass 18 Conventions" created via kb-save +
  store-write-doc (in-app authoring path); granted to Developer by dir name
  (file edit + watcher). VIB-2's Codex run explicitly said "applying the
  attached … pass-18 smoke-note conventions" — grant reached the prompt.
  Canary line not in README (rule targets smoke NOTES; VIB-3 probes output
  grounding directly).
- **UC18-19 partial ✓** MCP everything-http re-registered (16 tools found at
  save); granted to Developer; VIB-3 created to force echo-tool USE on Codex.
- Board/HTML observations: VIB-1 card showed Codex glyph + branch trace
  chip; review-queue badge live-updates; bell counts consistent.

### Later Phase B results (batch 2)

- **UC18-13 ✓** gh close PR #136 → reconcile detected instantly → ruling-17
  recovery packet (rework / archive / archive+deleteBranch) whose body
  PROMISES reopen-detection; gh reopen + reconcile → reconciler note "review
  is live again", packet auto-WITHDRAWN by the queued operator ~50s later.
  Only wart: during that window the packet card (stale "closed (not merged)"
  obs) renders beside the GitHub card showing "in review" — file as LOW
  (reconciler could stamp the packet "superseded" instantly, R16-3 spirit).
- **UC18-15 ✓ (R17-1 live)** post-review commit 643830c pushed via Contents
  API → reconcile → `pr.revisionDrift {aheadBy:1}` → accept dialog rendered
  rose MERGE HEAD row "643830c9f2ca — 1 commit added since review; they merge
  unreviewed" + healthy verdict; accept proceeded (honesty over blocking);
  PR #136 merged; vib-2 branch cleaned.
- **UC18-14 → VIB-2 verdict** revision-bound approve (73dccf7) after
  engage+run via task actions; operator recommendation applied via recId
  (NOTE: my first attempts used a wrong field name — the 409 copy "That
  recommendation was already resolved" conflates unknown-id with resolved;
  micro-nit).
- **UC18-20 ✓** Docs Writer created (global modal walk: delivery-withheld
  template note, stage chips, loadable-context chips — DEFAULT-ON for all org
  skills, worth an owner question; no model/effort at global level). Added to
  VIB via "Add from library · 1" (copies definition+grants; "global stays the
  source" copy). Project-level Edit modal HAS Model (Default/Sonnet/Opus/
  Haiku) + Effort (Low…Maximum) pickers + Allowed/Human-only/Off capability
  rows; granted 4 repo caps = Allowed → project.md fork verified (also noted
  `use-web-search-fetch: direct` default). Operator ROUTED VIB-4 to
  docs-writer (delivers:true, claude backend) over Developer.
- **UC18-19 ✓ Claude parity** VIB-4 init: mcp__everything-http__* (16 tools,
  hyphenated) + viberr_agent (ask_human/post_comment only — capability-gated)
  both "connected". Codex side already proven by VIB-3's echo call. → F18-8
  though (ungoverned SDK catalog).
- **UC18-12/collision class CLOSED** — 4 variants exercised total; stale
  vib-3/4/6 leftovers deleted via gh; VIB-4's packet body correctly said "I
  cannot delete/rename the GitHub branch myself" (capability honesty).
- **RBAC/session batch ✓** Logout/login flows; Mira first-login forced reset
  shows F17-L11 fixed copy ("You signed in with a temporary password"); home
  member-scoped (LAB invisible, "Org admins manage this" cards); ⌘K palette
  as Mira: "autonomy" → nothing (LAB-1 hidden), "smoke" → VIB tasks only
  (R15-4/5 live); VIB-1 as contributor: no Force-accept, no Archive, perms
  panel reads "Take / release your own seat" / "Maintainer, admin, or the
  task's own owner" / "Maintainer or admin only"; Done task banner "This task
  is closed — comments are still recorded" (R7-6); Lexical @mention menu:
  posted @Developer question as Mira (`to: agent` recorded).
- **F18-10 (HIGH, product) — full-autonomy strands after delivery.** LAB-1:
  operator delivered PR #137 then stopped "per the single-boundary rule";
  NOTHING re-queues it (delivery isn't a transition, so the R-A re-trigger
  never fires) → task sat `waiting: human` with recommendations:[], no
  packet, no card — invisible dead-end under the AUTONOMOUS preset. Manual
  run-operator(autonomy=full) resumed the arc. Fix candidates: post-delivery
  operator re-queue when autonomy=full (or always), or an explicit
  recommendation card at minimum. (Codex developer note ALSO confirmed KB
  grounding: "including … required SPICEBERRY footer".)

## UI walk log (screenshots in transcript)

- Home (signed in, zero projects): greeting, empty-state card with 3-step
  explainer, Settings summary cards (connections / users / agent resources).
  Coherent. Bell badge 20 (see F18-1).
