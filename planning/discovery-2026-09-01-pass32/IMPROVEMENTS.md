# Pass 32 — Improvement candidates & defects (living ledger, 2026-09-01)

Statuses: OPEN (untriaged) / CONFIRMED (verified in code or live) / QUESTION (needs owner) /
FIXED / REFUTED / DECIDED-NO-CHANGE. Every item carries a `path:line` once confirmed in code.
Sources: live UI use (NOTES.md running log), doc-refresh subagents (docs/00..07 "Findings"
sections), owner answers.

## F. Functional defects (ranked)

- F32-1 CONFIRMED (HIGH, ops honesty): disk-free readout wrong on bind-mounted data roots.
  `app/server/ops/disk-space.server.ts:105-112` multiplies `statfs.bavail/blocks` by `bsize`;
  on Docker Desktop virtiofs `f_bsize` (~1 MiB) ≠ `f_frsize` (4 KiB), and Node exposes only
  `bsize`. Live: container `df` says /data 229G total, 3.7G free (99%); app says "1004 GB free
  of 62747 GB"; the controller told the owner "~1.07 TiB free" via `viberr_ops instance_health`.
  A near-full host disk is reported as roomy. Fix: measure via `df -kP <root>` (POSIX,
  frsize-aware) with the statfs value only as a fallback + a sanity clamp; lock with a fake
  statfs whose bsize≠frsize.
- F32-2 CONFIRMED (MEDIUM, live-update gap): KB watcher re-index emits no SSE.
  `app/server/files/kb-watch.service.server.ts:94` only logs "kb watcher re-indexed"; the
  Agent resources tab kept "0 docs · re-scanned just now" after a host-side file drop until a
  manual reload (log showed docCount 1). NFR4 promises no-refresh propagation; the stale
  "re-scanned just now" is actively misleading. Check the same for skills/MCP/profile edits
  from disk.
- F32-3 CONFIRMED (MEDIUM, deployment design): Codex auth auto-seed copies a SINGLE-USE refresh token
  the host CLI also holds; whichever side refreshes first invalidates the other ("refresh token was
  already used" at VIB-1's first Codex run). compose.yml:23-34 promises "the container copy stays
  self-managing". Needs a documented posture (dedicated login for the container, or a warning when
  the seeded token's last_refresh predates the host copy's) + the credential-refusal reading of F32-4.
- F32-4 CONFIRMED (MEDIUM, honesty): after a real credential refusal `/resources/health` still reports
  `backends.codex: "real"` (`app/server/ops/health-snapshot.server.ts:105-106` via `isBackendAvailable`)
  and `backendCredentialHealth` (`runtime-registry.server.ts:349`) judges file presence, so the
  controller told the owner "Codex credential usable" while the token was dead. Record a
  "credential refused since <run>" reading from the real failure (ruling 78's shape), cleared on
  the next real success; show it on Insights/org-settings + instance_health.
- F32-5 CONFIRMED (HIGH, crash) = F04-U1: unguarded `decodeURIComponent` in `app/ui/markdown.tsx:170,
  227,248` throws on a malformed percent-escape in an attachments link → whole task page falls to the
  error boundary. A single hostile/typo'd comment breaks the deepest surface in the product.

- F32-7 CONFIRMED (HIGH, stranded task): after `resolve_remote_collision` succeeds (PR #265 opened via
  `manualDeliverForReview`, readiness lifted to ready) the task sits at In Progress with
  `waiting: human`, `recommendations: []`, NO operator re-run (no agent_runs row after the
  resolution at 20:18) and no "Move to Review" recommendation. R20-1 promises a recovery-option
  confirm RE-QUEUES the operator; R19-4 promises a supervised delivery leaves an actionable next
  step (`ensureDeliveredNextStep`, now folded into task-actions.server.ts:5182/5471, only on the
  operator-authorized path). The human sees "waiting on a human" with nothing to click but the
  stage menu. ROOT CAUSE: `NO_REQUEUE` (`task-actions.server.ts:6566-6574`) lists
  `resolve_remote_collision` with the comment "the re-delivery's own machinery owns the follow-up" —
  but the redelivery runs through `manualDeliverForReview` (a HUMAN-authorized delivery), and R18-2
  deliberately does NOT re-trigger the operator for a supervised delivery while the Move-to-Review
  synthesis (`:5182/:5471`) runs only on the operator-authorized path. On a supervised project the
  follow-up is owned by nobody. Fix: drop the kind from NO_REQUEUE (re-queue with a
  packet-resolved trigger carrying the delivery outcome) or run the next-step synthesis on the
  manual path when the resolver is a packet decision; lock with a test on a supervised project.

- F32-9 CONFIRMED (MEDIUM, controller honesty): `viberr_ops.instance_health` does not include the
  `backendQuotaExhausted.<backend>` reading (instance_settings row written by the V4/V9 quota
  machinery), so 10 minutes after VIB-2's Codex run was refused for quota (recorded, shown on
  Insights) the controller told the admin "codex … usable credentials … no quota exhaustion
  flagged". Add the exhaustion/rate-limit readings (and the credential-refusal reading of F32-4)
  to the health snapshot the tool serves; the controller must not have a second, poorer source
  than the Insights page.
- UC-22 note (GOOD): the controller refused the concurrency-cap change out loud ("I don't have a
  tool to set an instance-wide run concurrency cap … has to be set on the Org settings surface")
  and executed the Sandbox stage rename under the asker's authority. Consider a `set_run_concurrency`
  controller tool (org-admin gated) since the setting has no ceremony — or record the omission as
  intended.

- F32-8 CONFIRMED twice (MEDIUM, operator brief vs target grants): on VIB-1 AND VIB-2 the operator's
  reviewer brief said "call/re-call qa_echo yourself" although the Reviewer holds no MCP grant (KBs
  are inherited from the deliverer, R18-1; MCPs are not); the reviewer burned 20-30 turns per task
  hunting (`find /`, grep of the workspace). The operator snapshot already carries
  `deployedSpecialists[].resources`; the run_agent tool (or the persona) should state the target's
  mounted MCP servers so the brief cannot promise a tool the run lacks. → TESTPLAN P32-T19.

- C32-1 OBSERVATION (LOW, isolation): runs share the container user's `~/.cache/claude-cli-nodejs`; a
  reviewer located and read the deliverer run's `mcp-logs-qa-echo/*.jsonl` via `find /`. Harmless here;
  a per-run HOME/cache would close it if MCP server logs can carry secrets.
- C32-2 OBSERVATION (LOW-MED, review base): the VIB-2 reviewer's isolated support checkout had a STALE
  `origin/main` (VIB-1's merge missing) so `git diff origin/main...HEAD` showed README.md from VIB-1;
  it found the right base only by reasoning. Refresh the mirror / fetch before every support clone so
  a reviewer's base equals the PR base.

- F32-10 CONFIRMED (MEDIUM, guard order, from RBAC-PROBES.md D1): `transitionStage`
  (`app/server/tasks/task-actions.server.ts:4369`) returns early on `fromStageId === toStageId`
  BEFORE `requireAction(approve-transition)` (`:4452`) and `requireProjectMutable` (`:4477`), so a
  VIEWER posting `intent=transition&to=<current stage>` gets HTTP 200 `ok:true` + toast "Moved VIB-3
  to Triage" (`app/routes/project.task.tsx:747`), no audit denial row, and the archived-project 409
  is skipped too. `reorderTask` guards first (sibling clean). Fix: authorize before the idempotent
  short-circuit and never toast "Moved" for a no-op. → TESTPLAN P32-T21.
- D32-15 (copy, from RBAC-PROBES.md): `/org/settings` and `/insights` 403 for non-admins render only
  "Error 403 · Forbidden" — the reason string "This area requires the admin role." is in the payload
  but the error boundary shows the HTTP status text; the user learns THAT, never WHY.

- F32-11 CONFIRMED (LOW-MED, honesty): force-accept on a task with an OPEN decision packet (VIB-3 at
  Triage) cleared the packet silently — no timeline note, no `task.packet.*` audit row, and the
  force-accept ceremony (MERGES/REVISION/VERDICT/SKIPS/BYPASSING) never mentioned the open decision.
  Add a "WITHDRAWS: open decision <title>" row to the ceremony and a typed packet-withdrawn event +
  audit row on every terminal acceptance that closes a packet (archive already discloses this in
  its WITHDRAWN row). → TESTPLAN P32-T23.

## D. UI/UX coherence & copy

From doc 04 (UI surfaces) refresh, 2026-09-01 — full text in docs/04-ui-surfaces.md §Findings:
- F04-U1 CONFIRMED (HIGH, crash): `app/ui/markdown.tsx:170` `repairAttachmentHref` calls `decodeURIComponent` unguarded (also `MarkdownImg` `:227`,`:248`) one function above the `safeDecodeName` guard added in ruling 105 (`:179-185`,`:284`); micromark leaves `%zz` intact → a comment containing `[x](attachments/%zz.png)` throws mid-render → the whole task page falls to the error boundary. Mechanically verified by the doc agent. (Filed under F as F32-6 too.)
- D04-U2/U3 = D32-3 (titles): six workspace views inherit the project title (`app/routes/project.tsx:64-68`); org.settings = "Instance settings"; task page `project.task.tsx:1070-1072` = "{key} · {title}" without suffix; login inverted. Three grammars across eleven titled routes.
- D04-U4 (low): `<p className="pol-note">` at `controller-admin-panel.tsx:319` is the only `<p>` .pol-note (ten `<div>` siblings); rule `app.css:2444-2448` sets no margin-top and there is no `p` reset → extra UA top margin inside the flex column.
- D04-U5 (dead CSS): `.own-role` (`app.css:3354`), `.sched-form` (`:1758`), `.sched-controls` (+ `.flabel`, `:1759-1760`), `.sched-note`(+placeholder, `:1766-1767`), `.sched-note-inline` (`:1763`) have no emitter in app/ (only stale .claude/worktrees copies). The class-coverage gate (`app.css.test.ts:642`) is one-directional (markup→rule).
- D04-U6 (medium, primary hierarchy): "Retry on {backend}" (`runs-panels.tsx:601`) is `.btn.primary.sm` while every sibling run-start (`execution-profile.tsx:389`,`:581`) was demoted to secondary in pass 30.
- D04-U7 (low-med): `/org/settings` always shows two solid primaries — S3 "Save target" (`org-settings-page.tsx:427`, unconditional below tabs `:205-207`) beside the tab's own primary (e.g. "Save controller" `controller-admin-panel.tsx:433`); the S3 form is never collapsed.
- D04-U8 (copy): controller tab lead `controller-admin-panel.tsx:301-305` "This tab configures the controller itself, which only org admins can do" vs default locks (model+effort only); the note below discloses, the lead is read first.
- D04-U9 (a11y, medium): locked grant chips render as `<span class="pick-chip on">` with aria-hidden check and no role/aria-disabled/readonly state (`controller-admin-panel.tsx:154-163`,`:183-191`); nothing associates the lock note with the group; contrast F19-5 gave MissingChips aria-pressed.
- D04-U10 = A00-5 (ux spec `:721-731` stale vs ruling 108/106).
- D04-U11 (latent): the single-segment interception rule lives only in `markdown.tsx:279-284`; the other three lightbox call sites (`attachments-panel.tsx:125-134`, `timeline.tsx:158-169`,`:335-352`) are safe by construction with the invariant only in a comment (`attachment-lightbox.tsx:264-271`); a fifth caller passing `?x=1` yields `…?x=1?download=1`.
- D04-U12 (honesty): Insights "Coordination overhead" (`insights-page.tsx:216-225`) never says its denominator is cost-REPORTING runs only, unlike "Total cost" (`:84-88`).

- D32-1 CONFIRMED (copy): org-settings footer "…last freed 0 B." — "automatic cleanup runs
  every 6h" starts lowercase mid-line.
- D32-2 CONFIRMED (format, ruling 4): `app/features/insights/insights-page.tsx:318,337,358,379`
  use `toLocaleString()/toLocaleDateString()` (server locale, en-US "9/1/2026") while the rest
  of the app uses the shared formatter ("Sep 1, 2026", "today 19:39"). Line 371's comment
  admits the server-locale rendering. Route through `~/shared/dates`.
- D32-3 CONFIRMED (titles): only 9 routes set `meta` titles (`app/routes/*.tsx`): board /
  agents / policy / github / settings / project-controller inherit "viberr · Viberr" (no page
  name); `org.settings.tsx:105` = "Instance settings" (no " · Viberr"); `login.tsx:31` =
  "Viberr · Sign in" (reversed order). One convention: "<Page> · <project> · Viberr".
- D32-4 nit: `/favicon.ico` 404s in the server log (root links `/favicon.svg` only).
- D32-5 CONFIRMED (UI, MEDIUM, contrast): segmented-control SELECTED + HOVERED segment has
  invisible text. Measured on the Policy role radios: selected "Contributor" under the pointer
  = bg rgb(236,238,244) AND color rgb(236,238,244); the other selected segments (not hovered)
  = color rgb(27,29,37). Same symptom on the Add-MCP "stdio" transport segment. The hover
  rule overrides the selected text color while the selected bg stays light (white on white).
  app.css contrast gate is hover-blind here. Find the `[aria-checked=true]:hover` composite.
- D32-6 CONFIRMED (copy): MCP row "1 tools · checked just now" (plural).
- D32-7 (low): global New-profile dialog has no Role field → role = name → card/rail shows
  the generic "Agent profile" subtitle while seeded profiles show a real role.
- D32-8 (nit): empty capability bucket ("RECOMMENDS ONLY") still renders its header.
- D32-9 (vocabulary): one capability mode is rendered as "Allowed" (project profile editor
  radios), "ACTS DIRECTLY" (agent card), "direct" (policy summary counts). Decide one word or
  make the mapping explicit.
- D32-10 (density): Policy page "Rules that reach beyond project roles" is a single 9-line
  paragraph.
- D32-13 (copy): board card owner cell reads "unassigned" at the entry stage but "awaiting owner" once
  work started, both for an unowned task; one label, or make the second honest ("unowned · any
  contributor can take it").
- D32-12 (copy nit): profile-save toast "changes apply to future assignments" — a RESUMED run picked
  the new grants up immediately (verified VIB-2); say "from the next run".
- D32-14 (low): Activity → Stream actor filter lists "Docs Writer" twice (one option per backend leg
  of one profile: codex run + claude run); dedupe actor options by profile id, not by (label, backend).
- D32-11 (layout, low): Policy → Agent capability rows: a long stats line ("8 direct · 0
  recommend · 3 human · some grants advisory on Codex") squeezes the name column so "Docs
  Writer / Agent profile" wraps to 4 lines at 1440 and overlaps at 1280. Let the stats wrap
  under the name or truncate the advisory note into a chip.

## A11Y

- A11Y-1: Allow-access dialog "Local" method button has no accessible name (siblings get
  theirs from the "isn't configured" title).
- A11Y-2: Agent resources tab: three buttons named "New" + one "Add" (KB / Skills /
  Profiles / MCP) — scope the names.
- A11Y-3: New/Edit global profile dialog backend segment buttons (Codex / Claude) unnamed.
- A11Y-4: KB pick-chips' accessible name is the store path (`store://kb/<dir>/`) while
  skill/MCP chips use display names.
- A11Y-5: "Add from library" rows and the Agents rail profile rows are unnamed buttons.
- A11Y-6: Home "Settings" tiles are links with no accessible name.

## A. Docs-vs-reality drift

From doc 00 (product intent) refresh, 2026-09-01 (all CONFIRMED by the doc agent, high confidence unless noted):
- A00-1 decisions.md ruling 7 says TEN packet kinds (`docs/architecture/decisions.md:167-173`), schema has ELEVEN (`app/schemas/task-file.schema.ts:129-165`, resolve_remote_collision); file-formats.md:219,247 already says eleven; ruling 77 (`:921`) still calls discard_branch "the tenth". Third drift of this count.
- A00-2 decisions.md Route map (`:1642-1655`) omits shipped `/insights` (`app/routes.ts:33`) and `/org/settings/audit-export` (`app/routes.ts:31`).
- A00-3 architecture.md:869 "There is no retention machinery" for attachments is false since ruling 105's completion-time prune (`app/server/files/task-attachments.server.ts:108,165,188`; driven from `task-actions.server.ts:3139,3193-3197,3361`); same bullet still says "timeline thumbnails with an in-app lightbox" (now universal card + Download).
- A00-4 UX spec `:1140` still instructs testing Safari + Firefox after ruling 103; `:1124`,`:1139` keep retired mobile/tablet vocabulary.
- A00-5 Rulings 106/107/108 exist in decisions.md only: `ux:725` (grants/instructions described as editable; effort missing), `ux:729` (old "not in the store" treatment vs MissingChips / locked disclosure), `ux:727` (no mention of the pinned viberr_ops chip), `architecture.md:917-942` (no lock, no ops mount). Ruling-44 failure mode recurring.
- A00-6 (med-high, C-class too) ruling 102 audit export: `app/server/db/retention.server.ts:98-110` appends `<root>/audit-exports/audit-events-<date>.jsonl` on every boot purge; dir NOT in `DATA_ROOT_SUBDIRS` (`app/server/files/file-store-root.server.ts:26-40`), not in architecture.md's tree (`:838-865`), no rotation/size bound, no runbook entry — an unbounded identity-event file nobody's backup knows about.
- A00-7 (med-high) ruling 17 (`decisions.md:222-223`) and ruling 77 (`:923`) say remote-branch deletion is packet-resolution-ONLY via pr-diverged; resolve_remote_collision (`task-actions.server.ts:6438-6445`) is a second path. Letter false, spirit intact.
- A00-8 (C-class) `app/shared/capabilities.ts:228` and `:259` both add `execute-code-or-write-repo` to `ENFORCED_CAPABILITY_IDS` (Set, harmless today; a future edit deletes the wrong copy).
- A00-9 `app/routes.ts:67` comment says "seven project views + task"; there are eight. UX spec `:1047` says nav order lives in `app/features/shell/nav.ts` with NO test pinning it.
- A00-10 (med) decisions.md §Layout (`:26-37`) schema list omits goal-file.schema.ts; server line omits controller/.
- A00-11 FR17 (`prd.md:229`) lacks ruling 105 (prune/viewer); FR40 (`prd.md:241`) says org admins modify grants+instructions, contradicting ruling 108's default lock.
- A00-Q open questions carried: Q1 (FR4 non-member label), Q4 (which doc wins; decisions.md:3-6 header), Q5 (FR bodies not rewritten), Q6 (NFR1 threshold), Q8 (NFR8 note not extended for ruling 101), Q9 (90-day number has no ruling), Q10 (FR23 role undefined), Q11 (FR39 restatement — architecture.md:940 has it), Q12 (held D7/D10/D11/D12), Q16 (admin persona journey), Q17 (architecture.md:254,1171-1172 "not fixed yet" auth/PAT primitives), Q18 (mobile leftovers); new Q19 unlock visibility in audit, Q20 unauthenticated /resources/health quoted by chat, Q21 NFR8/FR40 naming the two in-process authority servers.

## B. Gate gaps

From doc 06 (testing) refresh, 2026-09-01 — full text in docs/06-testing-verification.md §8:
- B06-T1 CONFIRMED (process): GitHub Actions CI is GREEN again (billing block lifted between 2026-08-31T20:51Z and 09-01T06:52Z; last 8 runs verify+e2e success). No doc records it; memory + pass notes still say CI cannot gate. CONTRIBUTING.md:42,:74 satisfiable again → treat CI as a real gate from now on.
- B06-T2 CONFIRMED (flaky gate): `vitest.config.ts:9-22` sets no `testTimeout`; CI run 33479481246 on 58e109d6 had 6 failures, 5 = "timed out in 5000ms" (`app/server/db/self-heal.server.test.ts:160,:186` ×3, `app/features/agents/agents-route.server.test.ts` ×2, `app/server/tasks/agent-completion.server.test.ts` ×1). Runner speed, not product — but a usually-spurious red CI is a gate people re-run instead of read. Fix: raise testTimeout for the fs-heavy suites (or globally to 20s).
- B06-T3 (MEDIUM, flaky assertion): `agent-completion.server.test.ts:766-791` "the reviewer's reply survives a following stale-read write" failed once on CI with "expected undefined to be truthy" (not a timeout); passed since. A data-loss race test that is intermittently red must be investigated, not dismissed.
- B06-T10: `app/features/toast-honesty.test.ts:11` docblock says "both kinds paint var(--fg); only the glyph differs" — since P13-D-10 the glyph COLOUR differs too (`app.css:1858` vs `:1862`).
- B06-T11: nothing pins `tools/oxlint/anti-slop/` byte-identical to `.claude/skills/install-anti-slop/assets/anti-slop/` (diff -rq clean today).
- B06-T16: `e2e/01-home-board.spec.ts:32-34` docblock still documents `liftOver`'s deleted `bottom`/`center` modes.
- P07-H (from doc 07): the org-settings audit-list keyboard fix (`org-settings-page.tsx:275-276` tabIndex + aria-label) has NO automated lock; the new test asserts only card copy.
- P07-C (from doc 07): the `"\n\nThe provider reported: "` marker is duplicated 5 ways (`agent-reply.server.ts:548` export; private copy `backend-quota.server.ts:135`; literals `claude-runtime.server.ts:725,1034`, `codex-runtime.server.ts:685`; DIFFERENT shape at `controller-run.server.ts:423`) with no drift pin; if a writer drifts, `quotaExhaustionEvidence` silently judges the whole line (re-opens the V4 transient-429 defect).
- Docs drift from 06: `docs/testing.md:11` + `README.md:85` claim a `db/` glob vitest removed in pass 12 (testing.md:14 contradicts itself); `README.md:78-89` lists 9 of 13 npm scripts (missing store:check/backup/restore/keys); `docs/testing.md:104-105` says the e2e config sets VIBERR_DATA_ROOT (it is `compose.e2e.yml:13`); pass-31 doc 06 said `docker compose exec app npm run seed` works (refused by `scripts/seed.ts:14-20`) and misstated lock posture (`scripts/restore.ts:56` whole-root + `secret-keys.ts:55` reseal DO take the writer lock); `test-artifacts/` is 12 TRACKED files not gitignored output; `scripts/measure-routes.mjs` has no runner/reference; `.gitignore:13` `e2e/.tmp-data/` is dead (stack uses named volume `e2e-data`); preserve-copy re-baseline recipe still prose-only (`docs/operations/deployment.md:236-241` teaches the lossy wipe).

## C. Runtime / code sharp edges

From doc 01 (server core) refresh, 2026-09-01 — full text in docs/01-architecture-domain.md §Findings:
- C01-A1 CONFIRMED (HIGH, durable loss class): packet `observations` is still a whole-array tolerant-parse sibling of the C5 class — `packetObservationSchema` (`task-file.schema.ts:478`) requires `k,v: string`; one malformed row (hand-edited `v: 9` → YAML number) fails the whole packet parse (`task-file.server.ts:405-425`), emits `packet.invalid` as a diagError (NOT a hardStop) and returns null; the next `updateTaskFile` drops the `## Packet` section (`serializeTaskFile` `:578`). Fix: per-row `tolerantRowsOf` for observations too.
- C01-A2 (MEDIUM): `goal-writer.server.ts:265` `updateGoalFile` has no stale-read repair (no `lastWritten`/`rememberWrite`/mtime slack) unlike task-writer `:69-91` and project-writer `:63-90` — pass-31 gotcha 10 predicted this; two back-to-back link-status writes on VirtioFS can lose one.
- C01-A3 CONFIRMED (HIGH, backup): `audit-exports/` (`retention.server.ts:104-110,180`) is outside `BACKED_UP_STORE_DIRS = [projects,agents,kb,skills]` (`backup.server.ts:74`) and `OPTIONAL_STORE_DIRS=[runtimes]` (`:82`) → `npm run backup` silently drops ruling 102's durable record.
- C01-A4/A5 (docs): `docs/architecture/file-formats.md:24-33` calls the subdir list complete but `audit-exports/` and `agents/definitions/` exist on every deployment; `effort` missing from the profile block `:407-430`.
- C01-A6 CONFIRMED (MEDIUM): five env vars still read raw `process.env` and are absent from the schema (`env.server.ts:16-183`) and `.env.example`: `VIBERR_MAINTENANCE_INTERVAL_MS`, `VIBERR_DISK_CHECK_INTERVAL_MS` (`maintenance.server.ts:263,268`), `VIBERR_DISK_LOW_FREE_MB`, `VIBERR_DISK_CRITICAL_FREE_MB` (`disk-space.server.ts:65,78-81`), `VIBERR_GITHUB_WRITE_PROBE` (`pat-validator.server.ts:98`); `VIBERR_BROWSER_EXECUTABLE` declared but not in .env.example.
- C01-A7 = F32-1 (disk arithmetic; also means `classifyFreeBytes` never fires low/critical → `checkDiskPressure` `maintenance.server.ts:328` never reclaims; health `degraded` never names disk).
- C01-A8 (MEDIUM): `github` cache parsed whole-value tolerant (`task-file.schema.ts:1412`, schema `:456`); `unownedPr` (`:473`) lives inside → one malformed commit row nulls the cache incl. the PR number the collision remedy reads (`github-reconciler.server.ts:1592`) → remedy degrades to "delete branch, close nothing". Per-row commits parse or hoist unownedPr.
- C01-A9 (LOW): `controller-profile.server.ts:176` treats the literal "orchestration runtime" as no-model — magic string, no constant, no test.
- C01-A10 (LOW): tolerant `effort` read + destructive rewrite (`controller-profile.server.ts:272-274`) erases a junk hand-edited value silently.
- C01-A11 (hygiene): `controller-profile.server.ts:129-136` builds `agents/definitions/` via `path.join(profilesDir, "..", "definitions")` outside file-store-root helpers.
- C01-A12 (LOW): raw `DELETE FROM notifications` in `settings-actions.server.ts:1027` bypasses the notifications store module.
- C01-A13 (gate): only `PACKET_OPTION_KINDS` is doc-locked (`file-formats-sync.test.ts:83-131`); `TASK_FRONTMATTER_KEYS` (`task-file.schema.ts:968`) and the profile key list are not.

From doc 02 (agent runtime) refresh, 2026-09-01 — see docs/02-agent-runtime.md §Findings for full text:
- C02-R2 CONFIRMED (HIGH, parity): the evidence carve-out defeats repo-write parity for the DEFAULT withheld shape incl. the seeded Reviewer: `resolveCodexSandboxMode` (`app/server/runtimes/codex-runtime.server.ts:385-387`) returns workspace-write whenever `spec.attachmentsWritableDir` is set, which is set iff `attach-evidence-references` is granted (catalog default direct, `capabilities.ts:142`; Reviewer grants it, `seed/agent-catalog.server.ts:187`). Claude Reviewer: no Edit/Write/commit; Codex Reviewer: writable shell-capable checkout. Matrix says "both backends" for execute-code-or-write-repo. → OWNER QUESTION E32-3.
- C02-R3 CONFIRMED (HIGH, defect): `attachmentsWritableDir` is NOT carried on resume — `ResumeRunInput` (`run-service.server.ts:1120-1168`), `carryResumeOptions` (:1179-1191), `resumeRun` (:1215), `ResumeConfinement` (`specialist-run.server.ts:2703-2720`), @mention resume (`task-actions.server.ts:1572-1597`). A resumed evidence-granted Codex run loses `additionalDirectories` (cannot copy to attachments/ while its persona says it can) and a write-withheld one drops to read-only (F22-03 reintroduced on the @mention path).
- C02-R4 CONFIRMED (MEDIUM, prompt stricter than enforcement): `specialist-run.server.ts:2479-2480` tells every supporting run "Do NOT create a branch, edit files, run git commit/push, or open a PR — even if a directive says to", but ruling 101(b) un-denied local edits + commit for write-GRANTED supporting agents; `resolveDeliveryPermissions` (`specialist-tool-policy.ts:192`) is not consulted on that branch.
- C02-R1 CONFIRMED (MEDIUM, drift): nine stale comment sites still describe the pre-parity R22 world (`adapter.server.ts:109-116` says the flag has no runtime consumer; `run-service.server.ts:589-591,836-838`; `specialist-run.server.ts:1258,2380,2468,2685`; `operator-run.server.ts:1097,1876,1925,2807`; `capabilities.ts:79`).
- C02-R5 (LOW, honesty): `resolveSpecialistMcpServersDetailed` (`specialist-mcp.server.ts:175`) skips a grant naming a RESERVED MCP name silently (`continue`) instead of via `drop()` (:162) → no unresolved row for a stale viberr_ops/viberr_browser grant.
- C02-R6 (LOW, dead code): `SkillMount.settingsWritten` (`skill-mount.server.ts:264,308,315,372`) written, never read; `claude-runtime.server.ts:360-368` names threading it into `buildSpecialistPersona` as the fix for R7.
- C02-R7 (MEDIUM, documented residual): Claude persona banner names native skills (`specialist-run.server.ts:2149-2165`) that `nativeSkillsForRun` (`claude-runtime.server.ts:371-379`) may then refuse (settings write failed) → persona lies. Consumer for R6.
- C02-R8 (LOW, latent): `codex-runtime.server.ts:396` `isDeliverer = spec.kind !== "reviewer"` — a controller run on codex would get danger-full-access; inert (controller forced to Claude at `controller-run.server.ts:206,337`).
- C02-R9 = A00-8 (duplicate Set entry).
- C02-R10 (LOW): maintenance pass mixes injected `dataRoot` (`ops/maintenance.server.ts:150-156`) with process-global retention windows (`ops/transcript-retention.server.ts:92-102`); pin with a test.
- C02-R11 (MEDIUM, carried): dispatch-completion contract degrades across restart — `dispatchedByName/UserId` live only in the in-process closure (`specialist-run.server.ts:2032-2039`); `recoverUnreactedAgentRuns` (`run-recovery.server.ts:218`) has no channel → recovered run posts no cc line, dispatcher never tagged. `outcome_key` just became a column; same shape works here.
From doc 03 (operator + controller) refresh, 2026-09-01 — full text in docs/03-operator-controller.md §Findings:
- C03-OC1 CONFIRMED (HIGH, audit honesty): controller `comment_on_task` (`app/server/controller/controller-toolkit.server.ts:974`) → `postAgentComment` (`agent-toolkit.server.ts:114`) writes its audit row as `actor {userId:null, label: controller}` (`:144-152`) — the ONE controller mutation whose audit row does not name the asking human (every other tool binds `"<email> · via controller"` via `controller-tool-guards.server.ts:84`). Only trace is the prose footer (`:996`).
- C03-OC2 CONFIRMED (MED-HIGH): `viberr_ops.read_run_log` on an empty page (`controller-ops-mcp.server.ts:281-313`) reports `olderExist:false`/`newerExist:false` and null cursors even when `run.logLines` is thousands — an overshooting `since`/`before` is told nothing older exists. Pinned as intended by `controller-ops-mcp.server.test.ts:503-514`; still a falsehood a model cannot cross-check.
- C03-OC3 CONFIRMED (MED, display re-derives runtime): `resolveControllerConfig` (`controller-profile.server.ts:178`) `fm?.resources.skills ?? ["controller-guide"]` only substitutes when the whole profile is missing (schema default `[]`, `agent-profile-file.server.ts:76`); an empty skills list shows "none granted" in the panel (`controller-admin-panel.tsx:196`) while `buildControllerSystemPrompt` (`controller-run.server.ts:633-636`) injects controller-guide anyway and prints the "attached by an org admin" banner (`:648-652`). Under a skills lock the admin cannot fix it.
- C03-OC4 = P07-F (resolve_remote_collision no-op without userId).
- C03-OC5 QUESTION (owner): `viberr_ops` reads (`read_store_doc` `:329`, `read_run_log` `:200`) write no audit row on success; only denials audit. First tools letting a MODEL enumerate store docs/run logs on a person's behalf. → E32-5.
- C03-OC6 (cosmetic): `operator-run.server.ts:1573` "advertised all nine" — `OPERATOR_PLAN_TOOLS` (`:1535`) has ten; `:1626-1637` duplicates its delivery rationale.
- C03-OC7 OBSERVATION (product gap): the four anti-noise guardrails (`app/shared/workflow/templates.ts:93`; read by `comment-guardrails.server.ts:161,:176`) have NO in-app surface — the only way to toggle one or change compression-threshold is a hand edit of project.md; the PRD (`design/prd.md:154,:188`) and decisions.md:1469-1481 frame them as per-project knobs. A project carrying the inert pre-104 operator-brevity row cannot see or remove it. → E32-6.
- C03-OC8 = P07-E (clear-reads-as-keep under a lock).
- P07-E (LOW, docs): a locked controller section posting an EMPTY list is a silent no-op (`controller-profile.server.ts:238-243` refuses only non-empty differing lists) — deliberate for blank-keeps, undocumented for scripted callers.
- P07-F (LOW/defensive): `task-actions.server.ts:6846` guards the whole resolve_remote_collision remedy on `actor.userId`; the false arm resolves+clears the packet and does NOTHING (no PR close, no delete, no redeliver, no note). Unreachable today via the approve-transition tier; add an explicit refusal.
- P07-G (LOW): `ControllerSectionLocks` + section labels hand-copied client/server (`controller-profile.server.ts:49` vs `controller-admin-panel.tsx:60,:83`); labels could live in a shared module like mcp-reserved/model-ids.
- P07-I (LOW, honesty): prose-derived quota reset dates render `toISOString().slice(0,10)` = UTC calendar date; can be a day off near date boundaries.
- C02-R12 (LOW, priced): `viberr_ops.read_run_log` forward mode (`controller-ops-mcp.server.ts:270-272`) materializes all rows (`listRunLines` `run-store.server.ts:264` has no SQL LIMIT) before slicing.

From doc 05 (RBAC/auth/GitHub) refresh, 2026-09-01 — full text in docs/05-rbac-auth-github.md §Findings:
- C05-A CONFIRMED (MED-HIGH, info leak vs own rule): `instance_health` and unauthenticated `/resources/health` include `browser.reason` built by `browserRuntimeStatus` (`app/server/tasks/specialist-browser-mcp.server.ts:118`) = "the pinned browser executable (VIBERR_BROWSER_EXECUTABLE=<abs host path>) is not on disk" (`health-snapshot.server.ts:108-110`); ruling 107 gated `backendCredentialHealth.detail` for exactly this reason and `resources.health.ts:8-9` claims "only aggregate counts, never data". Gate `browser.reason` the same way (or strip the path).
- C05-B CONFIRMED (MEDIUM, misleading copy + ordering): `resolveRemoteBranchCollision` (`github-reconciler.server.ts:1604-1632`) closes the third-party PR FIRST, then `deleteTaskRemoteBranch` (`:1636`) may refuse (default branch `:1483`, own PR open `:1490`, non-422 `:1550-1557`) → resolver writes "The branch collision was not cleared … Nothing was re-delivered" (`task-actions.server.ts:6878`) although a PR WAS closed (audited separately). Reorder (delete first, close after) or name the close in the refusal.
- C05-C (LOW, latent): `github-reconciler.server.ts:1618` non-null-asserts `actor.userId!` for the PR-close event while sibling `deleteTaskRemoteBranch` refuses "No acting user." (`:1473`); exported function; PR close runs BEFORE the guarded delete.
- C05-D CONFIRMED (MEDIUM): a 403 on the collision remedy's `PATCH …/pulls/<n>` close (`:1604`) opens NO scope violation, unlike `openTaskPr` (`pr-open.server.ts:600`) and `mergeTaskPr` (`:1408`) → a PAT missing pull_request:write yields a silent half-remedy with no chip/policy event/`github.scope_violation.opened`.
- C05-E = P07-E (comment at `controller-profile.server.ts:215-220` promises a refusal for clears that `resolveGrant` `:235-245` does not give).
- C05-G (docs): `app/routes/resources.run-log.ts:25-28,:39-40` docstring teaches paging on `hasMore`/`headSeq`/`oldestSeq` that ruling 107 disowned as page-local cursors.
- C05-H (convention): `github.pr.closed_unowned` is locked in `task-governance.server.test.ts:1466`, not in `audit/audit-coverage.server.test.ts` (the designated coverage file).
- C05-I (cosmetic): `repo-mirror.server.ts:199` `mirrorTimeoutMs = () => cloneTimeoutMs()` is a pure alias.
- Audit action count now 153 (incl. `github.pr.closed_unowned`, `github.delivery.next_step`). rbac.ts + auth/* byte-identical since pass 31.

From the owner's docs pass (PR #267, docs/validation/2026-09-01-doc-validation.md §11 "code-side drift, not changed"):
- V11-1 `app/features/agents/capability-matrix-modal.tsx` still says Codex file/command limits are "advisory (its runs are not process-sandboxed)" — stale after ruling 101 (and must reflect the pass-32 read-only+attachments ruling).
- V11-2 = C02-R1 (specialist-run comments "advisory since R22").
- V11-3 `shell/top-bell.tsx`, `routes/notifications.tsx` comments say "ruling 9 seeds the stub projects" without the demo-only caveat; `user-prefs.server.ts` mentions a retired "nudge" pref.
- V11-4 `resources.run-log.ts` emits error code "validation" and `resources.events.ts` "unauthorized"; neither is in `ERROR_CODES`.
- V11-5 `MANAGED_SETTINGS.claudeMdExcludes` is still passed to the SDK though proven inert (C4) — remove or comment as belt-and-braces.
- V11-6 `DEFAULT_COMPACTION.threshold` (60) ≠ project guardrail default (40); the constant is a fallback only — align or document.
- V11-7 `tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts` exists but is not registered.
- V11-8 `.claude/launch.json` `viberr-dev` hard-codes a machine-specific data root.
- V11-9 Dockerfile declares no `VIBERR_BUILD_*` ARG though `build-info.server.ts` describes one; `build.revision` is null in the image.
- V11-10 = C01-A6 (env vars outside the schema; now documented in configuration.md but still undeclared).

## E. QUESTION queue for owner (asked in batches with background + recommendation)

### Answered 2026-09-01 23:05 (batch 1) — these become pass-32 rulings to promote into decisions.md
- E32-1 → YES to both: confirm VIB-1's resolve_remote_collision ceremony (closes #255, deletes vib-1, redelivers); delete the other stale task-key branches with gh (tst-1 + PR #256, fv-3/4/5, lab-1, vq-2, vql-2/3/4, vqp-4, vvqx-2); vib-5 stays as the collision fixture.
- E32-4 → owner re-logs Codex on the host and copies auth.json into the container; I keep testing non-Codex paths and retry Codex when the file changes.
- E32-3 → **Ruling (pass 32): Codex parity = read-only workspace + writable attachments dir.** A write-withheld Codex run gets `sandboxMode: read-only` with ONLY the task's `attachments/` writable (verify the Codex SDK supports read-only + additionalDirectories; if it cannot, fall back to honest "advisory on Codex when evidence is granted" labeling on every surface).
  - **VERIFIED 2026-09-02 (cluster C): NOT expressible in the pinned Codex 0.146** — `codex-rs/protocol/src/protocol.rs` `SandboxPolicy::ReadOnly` → `get_writable_roots_with_cwd()` returns `[]`, and `--add-dir` ("Additional directories that should be writable alongside the primary workspace") only widens `workspace-write` (`codex-rs/core/src/config/mod.rs` folds `additional_writable_roots` into `workspace_roots`; the legacy read-only profile carries no write entries). The SDK's `additionalDirectories` maps 1:1 to `--add-dir`. The `codex sandbox` subcommand takes no `--add-dir`, and a live `codex exec` probe is impossible until the quota resets (Sep 18), so the verification is source-level on the exact pinned version.
  - **Implemented the ruling's stated fallback**: the carve-out stays (`resolveCodexSandboxMode`), and `codexRepoWriteAdvisory(grants)` (specialist-tool-policy.ts) tags exactly the carve-out shape (repo-write withheld + evidence granted; an EMPTY grant list runs fully withheld and is NOT tagged) as "advisory on Codex" on the profile editor row, the capability-matrix row (naming the profiles), the agent card's withheld bucket, and the run console's new `sandbox` inputs row (`RunInputs.sandbox`, filled by `describeCodexSandbox`). Ruling text for decisions.md (109) drafted in cluster D.
### Answered 2026-09-02 00:35 (batch 2)
- E32-6 → **Ruling: build a Guardrails card under Policy** (toggle per guardrail, number field for compression-threshold, audit row on change, retired/unknown rows shown inert + removable).
- D32-9 → **Ruling: ONE UI vocabulary for capability modes, file ids unchanged** — every surface renders direct|recommend|human|off as "Acts directly · Recommends only · Human-only · Off"; the project profile editor's "Allowed" radios are renamed to match.
- D32-13 → DECIDED-NO-CHANGE: the board owner cell keeps "unassigned" (entry stage) vs "awaiting owner" (work started) — intended wording; record in decisions.
- Packet coherence → **Ruling: packet authoring REFUSES `accept_completion` options unless the task is at the acceptance boundary with a healthy verdict** (same shape as the discard_branch guard); the operator is told to offer archive / edit-goal instead; humans keep force-accept.
- E32-5 → **Ruling (pass 32): viberr_ops reads are audited** — one `controller.ops.read` row per successful call naming tool, target id, asking user.

- E32-1 Stale task-key branches + open PRs on origin from earlier instances (vib-1 + PR #255,
  tst-1 + PR #256, vib-5 kept as fixture, fv-*, lab-1, vq*, vvqx-2). VIB-1 on this fresh
  instance collides with vib-1/#255. Recommendation: resolve through the app's own
  resolve_remote_collision ceremony (closes #255, deletes vib-1, redelivers) as a live test;
  delete the other stale branches with gh except vib-5; close #256 via gh as an outside-close
  test on a TST-less instance (no task will adopt it).
- E32-3 Codex parity carve-out (from C02-R2): ruling 101 let evidence-granted write-withheld Codex runs keep workspace-write. Since attach-evidence-references defaults to direct, the seeded Reviewer on Codex gets a writable shell checkout while on Claude it cannot edit. Options: (a) keep, but display "advisory on Codex" honestly for execute-code-or-write-repo whenever evidence is granted; (b) restrict the carve-out to `additionalDirectories=[attachments]` + read-only sandbox for the workspace (Codex supports read-only + writable extra dirs? verify); (c) default attach-evidence-references to off for withheld profiles. Recommendation: (b) if Codex's sandbox allows read-only cwd + writable extra dir, else (a).
- E32-4 Codex credential is DEAD on this deployment: the seeded /data/runtimes/codex-home/auth.json (== host ~/.codex/auth.json, last_refresh 2026-08-19) fails with "Your access token could not be refreshed because your refresh token was already used". VIB-1's Docs Writer (Codex) errored at turn 0 → recovery packet. Needs the owner: `codex login` on the host, then `docker compose cp ~/.codex/auth.json app:/data/runtimes/codex-home/auth.json` (picked up live). Until then every Codex parity check runs config-side only (mounts/run_inputs) and live work goes through "Retry on Claude" (sticky). DESIGN NOTE (F32-3): the auto-seed copies a single-use refresh token that the host CLI also holds — whichever side refreshes first invalidates the other; compose.yml's "the container copy stays self-managing" is only true if the host CLI is never used again.
- E32-5 (from C03-OC5) should viberr_ops reads (store docs, run logs) leave an audit row when performed for a person by the controller? Recommendation: yes, a single `controller.ops.read` row per call (tool, target id, asker) — cheap, and the only record that a model read a document.
- E32-6 (from C03-OC7) the 4 anti-noise guardrails have no UI. Options: (a) build a small Guardrails card under Policy (toggle + threshold), (b) declare them file-only in the PRD. Recommendation: (a), small scope, restores the PRD promise.
- E32-2 Host disk: the Mac's disk (bind-mounted as /data) has ~3.7 GB free — a container
  rebuild (`docker compose up -d --build`) may fail. Informational.

### Docs sub-batch dispositions (2026-09-02)

Every item below was RE-VERIFIED against the rebuilt `docs/` tree (owner commit `a86ec080`,
"docs: rebuild the documentation set from code truth") and the working tree at
`pass32/implementation` @ `478bed0` before anything was written. Several findings were
already moot; those cite where the rebuild fixed them. Gate after the edits:
`npx vitest run app/shared/docs app/features/shell/nav.test.ts app/server/config/env.server.test.ts`
→ 4 files / 25 tests passed.

1. **A00-3 attachments retention + viewer** — PARTLY MOOT, rest FIXED. No page in `docs/`
   ever said "there is no retention machinery" (that sentence lives in the stale
   `planning/planning-artifacts/architecture.md:869`, which `decisions.md`'s header and
   `docs/README.md` already disown as superseded by the code-verified set), and
   `docs/domain/agents-and-runtime.md` §4.4 step 4 already documented the prune. Fixed the
   three places that still described the pre-105 surface: `docs/product/glossary.md`
   (Attachments entry), `docs/architecture/data-model.md` §5 (the retention row said
   "none"), `docs/ui/surfaces.md` §5 (new copy rule: every kind opens a card with Download;
   text reader; unservable body drops Download) and the attachments route row; added the
   attachments paragraph to `docs/domain/task-lifecycle.md` §13, which had no mention at
   all. PRD FR17 handled under item 4.
2. **A00-4 Safari/Firefox + mobile vocabulary** — ALREADY FIXED BY THE REBUILD. `design/prd.md:160`
   declares Chromium-only with the strike recorded as history, `docs/product/overview.md:68`
   states ruling 103, `docs/development/testing.md` §4 says "Chromium is the whole declared
   browser matrix (ruling 103)". No doc instructs testing another engine. The surviving
   "mobile" words are not targets: `04-palette-mobile.spec.ts` is a real Chromium spec name
   and `surfaces.md`'s "the rail collapses at ≤ 720 px … there is no review-first mobile
   mode" describes shipped reflow plus the retirement. No change.
3. **A00-5 rulings 106/107/108 on the surfaces** — PARTLY MOOT, rest FIXED.
   `docs/domain/controller-and-goals.md` §5–§6 and `docs/operations/configuration.md` §2
   already covered all three completely. `docs/ui/surfaces.md` did not: added a paragraph
   under §3 (model/effort always editable via the agent-editor pickers; grant lists and
   doctrine read-only unless the `VIBERR_UNLOCK_CONTROLLER_*` variable is set; `viberr_ops`
   as a pinned, non-interactive chip) with links to both.
4. **A00-11 PRD FR17 / FR40** — FIXED, in the CANON copy first. FR17 gained a ruling-105
   amendment (completion-time prune of machine-stamped non-visual artifacts unless cited;
   universal card + Download + text viewer); FR40 gained a ruling-108 amendment (grants and
   instructions are a deployment decision, locked for org admins too, unlocked per section
   by env at deploy time, with the narrow-scope caveat stated). Edited
   `planning/planning-artifacts/prd.md` and copied it over `design/prd.md` — ruling 27's
   `prd-sync.test.ts` pins them byte-identical, so the mirror is a mechanical follow-up, and
   editing the mirror alone would have broken the gate.
5. **A00-1 ruling 77 "the tenth"** — ALREADY FIXED BY THE REBUILD. `decisions.md:988-991`
   carries an `**Amended** (pass 28 F28-L1 and pass 31 F31-6, noted 2026-09-01)` note ending
   `"Ruling 7's tenth" is historical`, and ruling 7 itself now says ELEVEN and names
   `PACKET_OPTION_KINDS` as the source of truth. Rulings are amended, never rewritten, so the
   original phrase correctly stays. Swept for other counts: the only remaining "ten" is
   ruling 7's own chronology ("count nine→ten … count ten→eleven"), which is history.
   `file-formats.md` says eleven and is test-pinned.
6. **Promote the pass-32 owner decisions** — FIXED. Added **rulings 109–116** to
   `docs/architecture/decisions.md` after 108, in house style: 109 Codex parity (the ruling,
   the source-level verification that Codex 0.146 cannot express read-only + writable extra
   dir, and the shipped fallback labeling, amending 101(c)); 110 the collision ceremony's
   fixed order, the 403 → `pull_request:write` scope violation, the branch cleanup with
   `vib-5` kept as fixture, and the never-strands follow-up (supervised card / full re-queue);
   111 one `controller.ops.read` row per successful `viberr_ops` read; 112 the Guardrails card
   under Policy (marked ruled 2026-09-02, implementation in cluster E); 113 the one capability-
   mode vocabulary, file ids unchanged (same marking); 114 the board owner cell keeps both
   labels (DECIDED-NO-CHANGE); 115 `accept_completion` refused at authoring off the acceptance
   boundary; 116 no per-run HOME/XDG cache, disclosed residual. Added the closing line to
   "Owner decisions recorded outside this file" pointing at 109–116, and bumped
   `docs/README.md`'s "108 numbered owner rulings" to 116.
7. **P07-E / C05-E lock semantics for scripted callers** — FIXED. `docs/operations/configuration.md`
   §2 gained a three-row table under the lock section: empty/absent = keep the stored value
   (blank means keep, never clear); non-empty and different = refused naming the section and
   its unlock variable; same members as displayed = passes (set comparison against the
   displayed list, stored list still written verbatim). States plainly that a scripted caller
   **cannot clear a locked list**, and that the instructions body follows the same rule.
8. **Build stamps + `.env.example` ↔ schema** — FIXED (docs) / already done (env). `.env.example`
   already carried `VIBERR_BROWSER_EXECUTABLE`, the ops-knobs block and all three
   `VIBERR_BUILD_*` stamps. `configuration.md` was the stale one: it still listed
   `VIBERR_MAINTENANCE_INTERVAL_MS`, `VIBERR_DISK_CHECK_INTERVAL_MS`, `VIBERR_DISK_LOW_FREE_MB`,
   `VIBERR_DISK_CRITICAL_FREE_MB` and `VIBERR_GITHUB_WRITE_PROBE` as raw `process.env` reads
   (they are in the schema now) and said "the Dockerfile does not set them" of the build
   stamps. Moved the five into §2, added a **Build identity** subsection covering all three
   stamps with the real `ARG`→`ENV` and the `docker compose build --build-arg …` invocation,
   and corrected the §3 preamble (it claimed these were undocumented in `.env.example`).
   **Mismatch report (env.server.ts NOT edited):** every one of the 43 schema keys appears in
   `.env.example`; exactly two `.env.example` names sit outside the schema — `LOG_LEVEL` (read
   by the dependency-free logger) and `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` (deliberately
   operational, never in an error message). Both are documented as such in both files, and
   `env.server.test.ts` passes. No undeclared `VIBERR_*` reads remain.
9. **Runbook + deployment** — FIXED, all three parts. (a) `audit-exports/` is in
   `BACKED_UP_STORE_DIRS` (`app/server/db/backup.server.ts:78`) and in `DATA_ROOT_SUBDIRS`
   (`app/server/files/file-store-root.server.ts:26`): said so in `runbook.md` (retention +
   backup sections), `deployment.md` (backup bullet; "nine `DATA_ROOT_SUBDIRS`" → ten) and
   `docs/development/scripts.md` (table row + the `npm run backup` detail).
   (b) `ensureRunRowColumns` (`app/server/db/sqlite.server.ts:145`) ALTERs `agent_runs` for
   `dispatched_by_name` / `dispatched_by_user_id` at open: documented as the additive-drift
   path in `runbook.md` (under the boot integrity WARN), `deployment.md` (a "check whether you
   need a remedy at all" lead-in to the re-baseline) and `data-model.md` §6, and wrote the
   **preserve-copy** re-baseline as the preferred general remedy — fresh file + migrations,
   then a foreign-keys-off column-intersection copy skipping the rebuilt-from-files tables,
   which is the shape `selfHealProjectionDbIfCorrupt` already implements — with the delete-and-
   rebuild recipe kept and relabelled as the lossy one. (c) the export files' unboundedness is
   now stated as deliberate (ruling 102's durable record, nothing rotates them) alongside the
   backup fact. Also corrected, in passing: the runbook's health table said `disk` is `null`
   "when `statfs` failed" — the reading is `df -kP` primary since F32-1, with statfs as the
   fallback.
10. **Scripts / testing drift** — MOSTLY ALREADY FIXED BY THE REBUILD. `README.md`'s table
    lists all 14 `package.json` scripts and `docs/development/scripts.md` agrees with it and
    with `package.json`; neither claims a `db/` vitest glob (`vitest.config.ts` includes
    `app/**/*.test.{ts,tsx}` only and `testing.md` §2 says `db/` and `scripts/` are not
    collected); `scripts.md` §1 and `runbook.md` already state that
    `docker compose exec app npm run seed` is refused (`scripts/seed.ts:14-20`), and the
    runbook's lock table matches `scripts/restore.ts:56` (whole-root restore takes the lock,
    `--file` does not) and `scripts/secret-keys.ts:55` (`reseal` takes it, `status` does not).
    One real gap fixed: `testing.md` §4 never said where the e2e data root comes from — it is
    the `x-e2e-env` anchor in `compose.e2e.yml` (`VIBERR_DATA_ROOT: /data`, shared by the seed
    one-shot and the app), and nothing in `playwright.config.ts` or `scripts/e2e.ts` sets it.
11. **`.gitignore` / `test-artifacts/`** — FIXED + reported. Removed the dead
    `/e2e/.tmp-data/` line: the e2e stack uses the project-scoped named volume `e2e-data`
    (`compose.e2e.yml`), and the only other references to that path are pass ledgers.
    `test-artifacts/` holds **12 TRACKED files** (`git ls-files test-artifacts`): six
    `controller-live/*.png` screenshots and six `pass20-*.txt` payloads. Committed evidence,
    not build output — nothing deleted, nothing gitignored.
12. **`scripts/measure-routes.mjs`** — ALREADY FIXED BY THE REBUILD:
    `docs/development/scripts.md:39` documents it (route asset closure, raw + gzip, from a
    prior `npm run build`, "not in `package.json`") and `README.md:243` lists it in the
    `scripts/` tree. Nothing to add; nothing deleted.
13. **Codex asymmetries** — FIXED. `docs/domain/agents-and-runtime.md` §4.3 gained the explicit
    statement that the write family binds on BOTH backends since ruling 101 with exactly one
    disclosed carve-out (repo-write withheld + evidence granted, an EMPTY grant list not
    tagged), that `codexRepoWriteAdvisory` names that shape, and that every surface prints
    "advisory on Codex" (ruling 109) — plus why the scoped delivery rows legitimately still
    read "advisory" (ruling 101(e): claude-only at the tool layer, bounded by the server-owned
    delivery gate). §2.5's sandbox-mode list now says why the carve-out arm exists, and
    gotcha 6 points at it. `capability-matrix-modal.tsx` (V11-1) was already corrected in
    cluster C, so no `app/` change was needed or made.
14. **`file-formats.md`** — ALREADY CORRECT, verified not assumed. §2's `task.md` example
    carries `priority`, `labels`, `dueDate`, `acceptance` and `goalRef`; the profile block
    carries an `effort:` line; the data-root list already said ten subdirs including
    `audit-exports`. Nothing added there (the new `agent_runs` columns are DB, not file).
    `npx vitest run app/shared/docs app/features/shell/nav.test.ts` passes, and the
    `codebase-map.md` nav sentence the nav test pins is untouched.

**Files changed by this sub-batch:** `docs/README.md`, `docs/architecture/decisions.md`,
`docs/architecture/data-model.md`, `docs/domain/agents-and-runtime.md`,
`docs/domain/task-lifecycle.md`, `docs/development/scripts.md`, `docs/development/testing.md`,
`docs/operations/configuration.md`, `docs/operations/deployment.md`, `docs/operations/runbook.md`,
`docs/product/glossary.md`, `docs/product/requirements-status.md`, `docs/ui/surfaces.md`,
`planning/planning-artifacts/prd.md` + `design/prd.md` (byte-identical mirror), `.gitignore`,
and this file. No file under `app/`, `db/`, `scripts/`, `e2e/`, `test-support/` or `tools/` was
touched.


## Cluster E + F dispositions (implementation, 2026-09-02)

Branch `pass32/implementation`, on top of clusters A–D. Every FIXED item carries a lock; the
ones marked *canaried* were reverted once to prove the lock goes red.

### Cluster E — UI/UX coherence
- D32-1 FIXED: "Automatic cleanup runs every 6h…" opens a sentence after the disk line's full stop
  (org-settings StorageLine); locks retargeted.
- D32-2 / P07-I FIXED (cluster E part 1): insights dates through `formatDayDotTime` /
  `formatCalendarDate` / `utcDayKey(...) + " (UTC)"`. A `$${…}` template slip in the first edit
  rendered "was refused $<date>" — caught on re-read, fixed, and the refusal title is locked
  (`insights-page.test.tsx`, regex over the formatter's real shapes).
- D32-3 FIXED (part 1): `pageTitle(...)` + `meta` on every route, locked by
  `app/routes/page-titles.test.ts`.
- D32-5 FIXED (part 1): `.mini-seg button.on:hover` restores the selected colour; gate + canary.
- D32-6 FIXED: MCP row counts its noun ("1 tool"); lock.
- D32-7 FIXED end to end: the global template editor gets a required **Role** field
  (`agent-template-modal.tsx`), `GagentView.role`, `SaveGagentInput.role` (blank keeps the stored
  role on edit, falls back to the name on create — the pre-pass-32 behaviour, kept for scripted
  callers), route field, and `gagents.server.test.ts` round-trip + blank-keeps canary. A stored
  role that merely repeats the name prefills EMPTY so an admin is invited to give a real one.
- D32-8 FIXED: an empty capability bucket says "None" under its header (mirrors ResGroup).
- D32-9 / D32-11 FIXED (part 1): ONE vocabulary (`MODE_LABEL`: Acts directly · Recommends only ·
  Human-only · Off) on editor radios, cards, matrix and policy counts; the "advisory on Codex"
  chip is an `mx-scope` chip, not part of the stats sentence.
- D32-10 FIXED: the cross-role rules are a four-item `.pol-rules` list; lock counts the items.
- D32-12 FIXED: profile-save toast and editor hint say "from the next run" (a resumed run mounts
  new grants at once, live VIB-2); locks updated.
- D32-13 DECIDED-NO-CHANGE (owner): board owner cell keeps its two labels.
- D32-14 FIXED: `task_events.actor_ref` for agents is `agent/<profileId>` (backend-agnostic), so a
  fork that ran one leg per backend is ONE actor option and one filter matches both legs; feed
  locks updated; *canaried*.
  Follow-through: the boot rescan is a content-hash short-circuit, so a derivation change never
  reached existing rows — `derivation-version.server.ts` stamps `PROJECTION_DERIVATION_VERSION`
  in `instance_settings` and forces ONE full rebuild at boot when the stamp is behind (bump it for
  every future derivation change); test + boot hook.
- D32-15 FIXED: the root ErrorBoundary reads `requireRole`'s JSON envelope
  (`{ error: { message } }`) as page copy, so a non-admin on /org/settings or /insights reads
  "This area requires the admin role." instead of "Forbidden"; `root.test.tsx` lock, *canaried*.
- D32-16 FIXED: an archived task's owner seat is frozen — `setOwner` refuses (validation, restore
  first) and both "Assign me" affordances are withheld when `archived`; server lock *canaried*.
- D32-18 FIXED: a human interrupt writes a timeline `note` AUTHORED BY the interrupter naming the
  run and backend ("The thread stays resumable; re-run the agent to continue"). `interruptRun`
  became async (best-effort note, like the continuity note; controller runs have no task file);
  every caller awaits (route, 5 test sites, coverage table). Lock in
  `task-runtime-route.server.test.ts`, *canaried*.
- D04-U4 FIXED: `.pol-note` uses the `margin` shorthand so the one `<p>` emitter has no UA top
  margin.
- D04-U5 FIXED: `.sched-form`, `.sched-controls(.flabel)`, `.sched-note(-inline|::placeholder)`
  and `.own-role` deleted with their orphaned comments; the P13-D-18 pin now covers the surviving
  `.sched-row`; a named retired-selector lock added (the coverage gate stays one-directional on
  purpose — the sheet legitimately styles runtime states no markup names).
- D04-U6 FIXED: "Retry on {backend}" is `.btn.sm` (secondary), matching pass 30's demotion of
  every sibling run-start.
- D04-U7 FIXED: the S3 target form folds behind a summary line + "Edit target" once a target is
  on file, and "Save target" is secondary either way; two locks.
- D04-U8 FIXED: the controller tab lead names the lock clause when sections are locked; lock.
- D04-U9 FIXED: every grant group is `role="group"` with an `aria-label`; a locked one is named
  "(locked on this deployment)" and `aria-describedby` the lock note (`#controller-lock-note`);
  locks for both states.
- D04-U10 = A00-5: handled by the docs sub-batch (ux spec).
- D04-U11 FIXED: `attachmentDownloadHref(url)` joins the `download=1` flag for any URL shape;
  the lightbox uses it; unit test covers query and fragment.
- D04-U12 FIXED: the Coordination overhead sub-text names its denominator ("reported by
  cost-reporting runs"); lock.
- A11Y-2 FIXED: the four resource "New"/"Add" buttons carry panel-scoped accessible names.
- A11Y-1, A11Y-3, A11Y-4, A11Y-5, A11Y-6, A11Y-7, A11Y-8, A11Y-9 VERIFIED-NOT-A-DEFECT: each
  control's accessible name is computed from its visible content (Local sign-in method, Codex /
  Claude segment, KB chips by display name with the store path as `title`, library rows, Agents
  rail rows, Settings tiles, packet option radios, stage `menuitemradio`s, editor accordion
  headers). The Browser pane's accessibility tree under-reports names built from nested spans
  (a known tool trap, see memory) — so each is now pinned by an RTL `getByRole(..., { name })`
  lock in the owning test file, which computes names the way assistive tech does.
- E32-6 FIXED (owner ruling, recorded under ruling 112 as landed): Policy → **Guardrails** card.
  `GuardrailView` in the policy view (defaults in shipped order, present or not, then extra file
  rows), `setGuardrail` (`on|off|value|remove`; adds a missing default row on toggle; `value`
  needs a positive integer AND a row with a `unit`; `remove` only for unknown ids; the
  GitHub-owned `delete-branch-after-merge` row refused — one fact, one editor), route intent
  `set-guardrail`, audit `project.policy.guardrail_changed` (before/after) rendered as a sentence
  in the Activity audit panel and counted for the "last change" chip, CSS `.guard-*`. Locks:
  route (RBAC 403, toggle round trip file→projection→audit→toast, idempotent no-op, threshold
  value + two refusals, remove rules), card (per-kind controls, not-in-project.md pill, read-only
  note), feed sentences; audit row *canaried*.

### Cluster F — tests & gates
- P32-T20 FIXED: `testTimeout: 20_000` in `vitest.config.ts`, locked by
  `app/shared/docs/vitest-config.test.ts`.
- B06-T3 FIXED — root cause, not a dismissal: the test simulated the VirtioFS stale read as
  "old content, NEW mtime", which the write-cache repair correctly treats as an external edit
  (disk wins) whenever the completion's bookkeeping exceeded the 100 ms mtime slack — i.e. a
  slow CI, not a data-loss race. The simulation now restores the pre-write mtime too (as
  `task-writer.server.test.ts` always did). The repair heuristic itself is unchanged.
- B06-T10 FIXED: toast-honesty docblock says the glyph AND its colour differ per kind.
- B06-T11 FIXED: `app/shared/docs/anti-slop-vendor-sync.test.ts` pins `tools/oxlint/anti-slop/`
  byte-identical to the skill assets (skipped where `.claude/skills/` is absent, e.g. CI — the
  assets are not in the repository).
- B06-T16 FIXED: `liftOver` docblock no longer documents the deleted aim modes.
- P07-H FIXED: the org-settings audit list's `tabindex=0` + `aria-label` are locked.
- V11-7 DECIDED-NO-CHANGE: `effect/no-service-constructor-imports` is vendored whole but stays
  unregistered — Viberr has no Effect services; the vendor-sync test states and asserts this.
- V11-8 FIXED: `.claude/launch.json` uses `$PWD/docker-data`.
- Housekeeping from D32-18: `run-service.server.test.ts` interrupt calls pass the store's
  `dataRoot` so the new note lands instead of logging "task file not found".

### Found during the cluster E live verification (2026-09-02)
- E32-8 FIXED (live, Activity page): the Audit panel's actor filter and its sentences printed the
  RAW stored `actor_label` for non-human actors — `agent:claude/developer (Implementation)`,
  `delivery`, `system:workspace-reconcile` — while the Stream beside it names every actor.
  `displayAuditActorLabel` decodes agent/system refs to the timeline's display names
  ("Developer (Implementation) · Claude", "Workspace reconcile"); `auditFilterActors` returns
  `{ value, label }` matching what the panel's filter compiles to (`COALESCE(u.name,
  a.actor_label)`), ONE option per person even when callers recorded a user under different
  labels (live: "Arda" listed twice); the `runtime.run.started` sentence now opens with
  "Operator" (its lock updated); locks in `activity-feed.server.test.ts`.
- D32-14 live evidence: after the rebuilt container booted, the log shows "boot rebuilt every
  projection for a derivation change {from:1,to:2,tasks:8,changed:11}", the stamp is stored, and
  `task_events` holds zero `<backend>/<profile>` refs; the Stream actor filter lists "Docs Writer"
  once.
- E32-6 live: toggled Meaningful comments off and on from the card — toasts, `project.md` row,
  two `project.policy.guardrail_changed` audit rows (beforeOn true/false), "4 of 4 enforced
  guardrails on" restored; the Policy "last change" chip now counts the guardrail change.

### CI follow-up (2026-09-02, verify job on PR #269)
- The first two cluster-E pushes failed `verify` with an UNHANDLED REJECTION ("database is not
  open" from `getRun` inside `interruptRun`), not a failing test: `interruptRun` had become async
  and read the DB AFTER awaiting the timeline note, while ~40 test call sites in five files still
  called it synchronously (my call-site grep had been head-limited), so the tail ran after the
  test's DB closed. Fixed twice over: the result is computed before the best-effort note (nothing
  touches the DB after the await; `noteInterrupt` catches its own failures), and every test call
  is awaited (sync cleanup helpers made async), so the record is complete when the call returns.
