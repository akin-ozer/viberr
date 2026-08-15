# Pass 20 — Implementation plan (ordered, conflict-free clusters)

> Built 2026-08-15 against `HEAD b97ad02` in the pass-20 worktree.
> Sources: `FINDINGS.md` (rulings R20-1..R20-8 + F20-1..30 + N20-1..14),
> `FIX-SPECS.md` (Specs 1–4, §5a–5d), `PRD-ALIGNMENT.md` (List 2 D2–D13, List 3 C1–C14).
> Scope gate is **R20-5**: every defect/inconsistency is in scope EXCEPT the pure
> never-built PRD features **D7** (packet anatomy fields), **D10/D11** (continuity-panel
> states / execution-truth continuity), **D12** (skeletons) — those are **HELD, out of scope**.
> No app code was modified in producing this plan. Every file/test path below was verified to
> exist at HEAD (three renames corrected vs the specs: the logger is
> `app/server/logging/logger.server.ts`, the seed catalog is `app/server/seed/agent-catalog.server.ts`,
> the GitHub card is `app/features/github/github-view.tsx`; activity-feed lives under
> `app/server/projections/`).

---

## 0. How to read this plan

The work is grouped into **clusters**. Two clusters may run **in parallel only if their
file-sets are disjoint**. Where clusters touch the same file, the plan names the shared file
and fixes the order. A handful of files are touched by many findings ("hot files"); §2
assigns each hot file to exactly **one owning cluster** that lands all its findings together,
which is what makes the rest parallelizable.

Findings that legitimately span two file-sets are **co-owned**: the entry appears in both
clusters, scoped to its half, and the split is called out. A co-owned finding is only "done"
when both halves land.

---

## 1. Cluster catalog

Each cluster: **id · theme**, the findings it resolves (with governing ruling), primary +
test files, shared-file flags, per-finding notes, and whether validation needs a **container
rebuild / live container** (`CONTAINER`) or is **unit/preview** only.

### C-MCP · MCP probe pipeline: secret redaction, crash-safety, honesty, warm-up, mount health
Owner of `app/server/org/resources.server.ts` (the second-hottest file).

- **F20-7** (HIGH, secret leak) — `git-output-redact.server.ts:63/85` gates the by-value
  scrub on `MIN_TOKEN_LEN = 8`, so a <8-char credential leaks into the row error, the toast,
  and persisted `last_error` (`resources.server.ts:869-873` `withDetail`). **Change:** scrub
  by value at ANY length (drop the length gate for the by-value pass) AND refuse credentials
  under 8 chars at save. Tests: `git-output-redact.server.test.ts` (5-char value scrubbed),
  `resources.server.test.ts` (short-cred save refusal + no plaintext in `last_error`). Canary:
  restore the length gate → the 5-char test must go red.
- **F20-8 (d) EPIPE half** (HIGH, availability) — `resources.server.ts:911-917` `send()`
  wraps only the synchronous `child.stdin?.write` and attaches no `'error'` listener, so a
  broken-pipe write is an uncaught fatal. **Change:** attach an `'error'` handler on the
  child stdin before/around every write; swallow EPIPE into the existing `down` outcome.
  Test: `resources.server.test.ts` using the `spawnImpl` seam (`:703`) — a fast-exit child
  written-to does not throw. *(F20-8's silent-death + lock-self-lockout halves are C-CRASH-LOCK
  — different files, parallel-safe. Co-owned finding, split by file.)*
- **F20-22** (LOW, honesty) — `resources.server.ts:930-933` `child.on("exit", …)` drops the
  `(code, signal)` args. **Change:** fold them into the reason (`"exited before responding —
  exit code 3"` / `"killed by SIGSEGV"`). Test: `resources.server.test.ts`.
- **F20-2** (LOW, hygiene) — defunct chromium/crashpad zombies under pid 1. Per **§5b**:
  (1) process-group teardown at `resources.server.ts:764-772/875-885` — spawn `detached:true`,
  kill `process.kill(-pid, "SIGTERM")` with a `child.kill()` fallback (`McpChild` gains
  optional `pid`); (2) `init: true` under the `app` service in `compose.yml:2-12` and
  `compose.e2e.yml:33`. Test: `resources.server.test.ts` asserts group-kill-when-pid /
  fallback, with a comment that the fake models no grandchildren (only compose-init proves the
  real leak closed). **CONTAINER** for the reaping proof.
- **N20-2** (nit → **R20-4**, Spec 4) — cold `npx` probe times out with no warm-up. Full
  Spec 4: `first_success_at` + `heuristic_warmups` columns in `db/migrations/0001_baseline.sql`;
  `isFirstRunInstallerCommand` + `firstRunInstaller` on the timeout arm
  (`resources.server.ts`); arm a capped-at-1 heuristic warm-up in `saveMcpServer`/`testMcpServer`;
  `mcp-warmup.server.ts` gains `heuristic` option + `first_success_at` stamping + counter
  rollback in `reapStaleWarmups`; copy in `resource-rows.tsx:200/218`. Tests:
  `resources.server.test.ts` (installer table + terminal-condition), `mcp-warmup.server.test.ts`,
  `org-settings-page.test.tsx` (warm copy). Canary: remove `heuristicWarmups < 1` → terminal test red.
- **F20-10** (MED) — an org MCP server that dies at run-spawn contributes zero tools while every
  surface says healthy; health is only learned from Add/Retest, never a run. **Change:** at the
  run mount (`app/server/tasks/specialist-mcp.server.ts`) a mount-time failure joins the existing
  `unresolved`/`unhealthy` disclosure by name, flags the registry row, and leaves a run trace;
  write the row-health back through `resources.server.ts`. Test: a `specialist-mcp.server` case +
  `resources.server.test.ts` row-flag. **Flag for check:** if the operator path also mounts org
  MCP (`operator-run.server.ts`), it needs the same mirror — but keep that read-only reference
  out of this cluster's edits (operator-run is the C-GOV-SERVER spine). **CONTAINER** to reproduce
  the crashed-spawn run.
- **N20-5** (nit) — Add-MCP modal slugifies silently (`resource-modals.tsx:137`). **Change:**
  render "will be saved as `viberr-browser`" under the field. Test: `org-settings-page.test.tsx`.

**Files:** `app/server/org/resources.server.ts` (primary), `app/server/secrets/git-output-redact.server.ts`,
`app/server/org/mcp-warmup.server.ts`, `app/server/tasks/specialist-mcp.server.ts`,
`app/features/org-settings/resource-rows.tsx`, `app/features/org-settings/resource-modals.tsx`,
`app/features/org-settings/resources-panel.tsx` (verify polling, likely untouched),
`db/migrations/0001_baseline.sql`, `compose.yml`, `compose.e2e.yml`.
**Tests:** `resources.server.test.ts`, `mcp-warmup.server.test.ts`, `git-output-redact.server.test.ts`,
`org-settings-page.test.tsx`.
**SHARED FILES (sequence):** `git-output-redact.server.ts` and `db/migrations/0001_baseline.sql`
are also edited by **C-GOV-SERVER** (redactProviderText / `model_availability` table). **C-MCP goes
first** on both. **Validation:** mostly unit; §5b reaping + F20-10 + N20-2 warm-up + F20-7 live
re-shot need **CONTAINER**.

---

### C-CRASH-LOCK · Silent-death visibility + lock self-lockout
Disjoint from C-MCP → runs in parallel with it.

- **F20-8 (a) silent death** (HIGH) — `loudlyShutDownOnStolenLock`
  (`data-root-lock.server.ts:466-481`) calls the async `logger.error` (an async
  `process.stdout.write`, `logging/logger.server.ts:82`) then `process.exit(1)` on the next
  line, truncating the write. **Change:** add a process-level `uncaughtException` /
  `unhandledRejection` handler that flushes synchronously (`fs.writeSync(2, …)`) before exit,
  and give the fatal-shutdown path a sync flush. Install point = the earliest process entry
  (candidate: `app/server/boot.server.ts`, or the server entry that calls it — pick the one
  that runs before any request; it is edited by no other cluster).
- **F20-8 (b) lock self-lockout** (HIGH) — restarted pid-1 container asks `isAlive(1)` about
  itself and refuses to boot forever (`classifyLock`, `data-root-lock.server.ts:~236-252`).
  **Change:** refuse to treat "pid 1 on my own hostname" as a live predecessor — compare
  `/proc/1` start time, or auto-reclaim when the holder pid equals this process's own pid.
  Test: `data-root-lock.server.test.ts` — the pid-1-self branch reclaims instead of refusing.

**Files:** `app/server/db/data-root-lock.server.ts` (primary), `app/server/logging/logger.server.ts`,
`app/server/boot.server.ts` (or server entry).
**Tests:** `data-root-lock.server.test.ts` + a logger sync-flush unit.
**SHARED FILES:** none with other clusters. **Validation:** classifyLock unit-testable; the
self-lockout + silent-death end-to-end need a **CONTAINER** kill/restart.

---

### C-DATAROOT · Data-root write resilience (never hang the whole app)
Per **§5d**. F20-1 is HIGH; the spin point must be pinned by fault injection before the fix.

- **F20-1** (HIGH, resilience) — a dead VirtioFS inode makes `create-project` peg the main
  thread forever. **Experiment first:** a test-only harness monkey-patches `node:fs`
  (`statSync/existsSync/mkdirSync/writeFileSync/renameSync`) to throw `ESTALE`/`EIO` for paths
  under a throwaway root and drives `createProject` (`project-create.server.ts:189`, write at
  `:299-302`) one syscall at a time under a wall-clock guard. Highest-prior hypothesis:
  `existsSync` returning **true** under a ghost inode (a silent wrong answer, and also the
  likely cause of F20-3). **Fix shape (build regardless):** (i) bound every
  `while (existsSync(...))` collision loop (32 attempts) and throw a typed `AppError` naming
  the dir — the concrete one is `store-files.server.ts:799`; (ii) `writeFileAtomic`
  (`atomic-file.server.ts:15-35`) grows an `ESTALE`/`EIO` arm beside its ENOSPC arm; (iii) an
  action-level watchdog wrapping mutating server-action entry points in a `Promise.race`
  against a 30s timer that throws `AppError`. Out of scope (side project): health-checked
  mount, self-healing remount, per-syscall retry.
- **F20-3** (MED, folded) — ghost-mount half-seeds the org (0 vs 3 resources). Same root-cause
  family; the seed path skipped work because `existsSync` lied. Covered by the same
  `existsSync`-bound + typed-error fix; add a seed-path assertion once the spin point is named.

**Files:** `app/server/files/atomic-file.server.ts`, `app/server/org/store-files.server.ts`,
`app/features/home/project-create.server.ts`, plus the action-watchdog wrapper (implement as a
**single** dispatch-level util to keep the surface minimal — do not sprinkle it per route).
**Tests:** `project-create.server.test.ts` (new fault-injection case; a `scripts/` probe if the
harness is too invasive), asserting the action rejects with a typed error and a subsequent
`/resources/health` still answers.
**SHARED FILES (sequence):** `project-create.server.ts` is also edited by **C-PROJECT-SETTINGS**
(F20-14 create-time repo probe) — **C-DATAROOT goes first**. **Validation:** fault-injection is
unit-ish; the watchdog under a hostile mount wants **CONTAINER**.

---

### C-GOV-SERVER · Governance server spine (the serialization backbone)
**Sole owner of `app/server/tasks/task-actions.server.ts` and
`app/server/runtimes/operator-run.server.ts`.** Lands Specs 1+2+3 server-side, §5c server half,
and the owner-exception, as **ordered internal phases** — every one of these edits restructures
`resolvePacket` or the failure/escalation pipeline, so they cannot be parallelized against each
other. Internal order: **Phase A (Spec 3 plumbing) → Phase B (Spec 1) → Phase C (Spec 2) →
Phase D (§5c server) → Phase E (owner-exception)**.

**Phase A — F20-4 provider-error pipe + model availability (Spec 3, R20-3, MED):**
extend ruling 69's scrub to the Claude/Codex spawn/run error pipe. New
`redactProviderText` + `PROVIDER_TEXT_CHARS=240` in `git-output-redact.server.ts`; a third
`providerText` field from `classifyCodexFailure` (`codex-runtime.server.ts:346`) and
`classifyClaudeError` (`claude-runtime.server.ts:393`); emitters append it to the persisted
`err` line; `safeCodexError` stops discarding text; raise the clamp
`task-actions.server.ts:2372-2376` 180→240; `openStuckLoopPacket` (`:1544-1610`) gets a
`Provider said` observation; `runFailureReason` (`agent-reply.server.ts:548-584`) splits the
marker; the operator escalation (`operator-run.server.ts:2093-2145`) stops dropping
`reason.text`. Model availability: new `model_availability` table
(`0001_baseline.sql`), new `app/server/runtimes/model-availability.server.ts`
(`MODEL_UNSUPPORTED_RE`, mark-on-real-400 / clear-on-success — **no synthetic probe**, ruling
19), wired at the two failure choke points and the two success arms; `model-catalog.server.ts`
stamps `unavailable` after `cloneCatalog` (not through the TTL cache). Tests:
`git-output-redact.server.test.ts`, `codex-runtime.server.test.ts` (`:508`/`:742` update),
`claude-runtime.server.test.ts`, `agent-reply.server.test.ts`, `task-actions.server.test.ts`,
`task-governance.server.test.ts`, `operator-run.server.test.ts`, **new**
`model-availability.server.test.ts`, `model-catalog.server.test.ts`.
*(The catalog UI/route/badge — `resources.model-catalog.ts`, `create-profile-modal.tsx`,
`agents-*` — are downstream and land in **C-AGENTS**; the seed default `gpt-5.6-terra` (R20-8)
lands in **C-SPECIALIST-MODE**, which owns the seed file.)*

**Phase B — F20-5 failure-packet recovery semantics (Spec 1, R20-1, MED):** every option
resolves + refuses repeat confirms (`clearPacket=true` for `block_on_policy` / `hold_runtime_debug`;
pre-read 409 for the `edit_goal`-stamped packet); `block_on_policy` label/effect reconciled to a
real unblock; new `"packet-resolved"` trigger (`operator-run.server.ts:119-127`) re-queues the
operator on every settled decision except the documented `NO_REQUEUE` set; refuse a **manual**
"Run operator" while a packet is open (`RunOperatorResult.refused` widened to `"open-packet"`).
Tests: `task-governance.server.test.ts` (update `:832`), `delivery-requeue.server.test.ts`
(reuse the `autoInvokeOperator` mock recipe), `operator-run.server.test.ts` (manual-refused vs
`pr-diverged`/`agent-reply` not-refused canary). *(Route/UI halves — the dropped `navigateTo`,
the run-button subline, the disabled-with-reason control — land in **C-GOV-UI**.)*

**Phase C — F20-6 no-change acceptance auto-detect + executable discard (Spec 2, R20-2, MED):**
`noChangeCandidate(fm)=!fm.pr` widens the accept-path probe off the agent's `noChanges` flag
(`no-change-completion.server.ts`); auto-detected acceptances repair `fm.noChanges=true` inside
the Done write of `applyAcceptanceWrite` + the packet accept arm; the has-work refusal borrows
the probe's counted sentence (`acceptanceRefusalReason`, `:5081-5112`) while `verdictGateReason`
(`pr-human-approval.server.ts:302-321`) stays pure; new `discard_branch` packet kind
(`task-file.schema.ts:68-88`) with `discardLocalTaskBranch` in
`push-workspace.server.ts` (refuses on-remote branches — ruling 17) and a `resolvePacket`
case gated on `approve-transition`; ruling 7 count nine→ten in `docs/architecture/decisions.md`.
Tests: `no-change-completion.server.test.ts`, `no-change-acceptance.server.test.ts`,
`task-governance.server.test.ts`, `push-workspace.server.test.ts`, `task-file.schema.test.ts`.
*(The accept-confirm third arm + the `PacketDiscardConfirm` dialog land in **C-GOV-UI**;
operator authoring string at `operator-run.server.ts:2703` stays here.)*

**Phase D — N20-14 §5c force-accept durable fact (server half, nit ⇄ C2):** add
`acceptance: "forced" | null` to `TaskFrontmatter`, written by the accept path when
`input.force===true` (replaces the audit-only `task.acceptance.forced` at
`task-actions.server.ts:5808-5817`); thread it through `rebuilder.server.ts:507` into the
projection and `app/shared/mapping/task.server.ts` into `TaskSummary`. Tests:
`task-file.schema.test.ts`. *(The `deriveValidation` "bypassed" arm + the `VALIDATION_DISPLAY`
string + card/hero display land in **C-VOCAB**.)*

**Phase E — F20-18 + N20-7 owner-exception (server half, MED + nit):** the owner-exception at
`task-actions.server.ts:4505-4519` (`else if (isOwner) …`) already lets a contributor-owner
resolve non-acceptance options; make it discoverable and give a contributor-owner a real
disposal path (or route/notify a maintainer when every packet option is above their tier).
Server-side: the disposal/notify path; test `task-governance.server.test.ts`. *(The packet-card
deny-note + `aria-disabled` presentation land in **C-GOV-UI**; the Policy/Permissions-rail
footnote documenting the exception (N20-7) lands in **C-WORKFLOW-POLICY**.)*

**Files:** `task-actions.server.ts` + `operator-run.server.ts` (primary, all phases),
`no-change-completion.server.ts`, `pr-human-approval.server.ts`, `push-workspace.server.ts`,
`codex-runtime.server.ts`, `claude-runtime.server.ts`, `agent-reply.server.ts`,
`git-output-redact.server.ts` *(shared w/ C-MCP — after it)*, `model-availability.server.ts`
*(new)*, `model-catalog.server.ts`, `app/schemas/task-file.schema.ts`, `rebuilder.server.ts`,
`app/shared/mapping/task.server.ts`, `db/migrations/0001_baseline.sql` *(shared w/ C-MCP — after
it)*, `docs/architecture/decisions.md`.
**Tests:** the eleven server test files named across the phases above.
**SHARED FILES (sequence):** `git-output-redact.server.ts` + `0001_baseline.sql` after **C-MCP**;
`task-file.schema.ts`/`rebuilder.server.ts`/`task.server.ts` before **C-VOCAB** (§5c display) and
**C-CONTINUITY** (D4 projection field). **Validation:** entirely unit-testable except the F20-4
live provider error, folded into the final live wave.

---

### C-GOV-UI · Task-detail governance UI (packet card, accept ceremony, run control)
Sole owner of `app/features/task-detail/decision-packet.tsx`. Depends on **C-GOV-SERVER**
(schema `discard_branch`, `canResolve`, accept arms, packet-resolved semantics).

- **F20-5 UI** (Spec 1) — drop the `navigateTo` deep-nav (`project.task.tsx:455-458`), retoast
  `block_on_policy` (`:428-429`); `OperatorRunControl` gains `blockedReason`
  (`execution-profile.tsx:669-675`), `ExecutionProfile` forwards `packetOpen`
  (`task-detail-page.tsx`), copy "Open decision — resolve it before running the operator."
  Remove the now-dead `navigateTo` branch in `task-detail-hooks.ts` if `block_on_policy` was its
  only producer. Tests: `task-detail-route.server.test.ts` (update `:354`),
  `task-disposition.test.tsx` (open-packet disables the run button + copy).
- **F20-6 UI** (Spec 2 §2.3) — `Accept­Confirm` third arm (`accept-confirm.tsx`) for
  `!noChanges && noPullRequest` ("Nothing to merge yet…"); `PacketDiscardConfirm` sibling in
  `decision-packet.tsx` (local dialog, `canDiscardBranch` gate). Tests:
  `accept-confirm.test.tsx`, `task-detail-components.test.tsx`.
- **F20-17** (MED) — when `!canResolve` (`task-detail-page.tsx:251`) mark every option
  `aria-disabled` and render one card-level deny note naming who can decide
  (`decision-packet.tsx:450-456/519-565`). Test: `task-detail-components.test.tsx`.
- **F20-18 UI** (MED) — the contributor-owner "every option forbidden" card renders the deny
  notes with a next step (routes to the C-GOV-SERVER disposal/notify). Test: same.
- **N20-8** (nit) — unify the two `[A,M]` deny phrasings (`decision-packet.tsx:383-385`).
- **C7** — normalise packet observation labels **at the writer** (length cap, reject
  path-shaped / camelCase labels, title-case) and dedupe the summary sentence against the first
  observation before render (`decision-packet.tsx`). The writer is the operator packet author;
  the render is here. Test: `task-detail-components.test.tsx`.
- **C14** — the archive dialog's "WITHDRAWN — nothing pending" row must name a live run, or its
  label must narrow to what it surveys (`decision-packet.tsx` `PacketArchiveConfirm`).
- **C1** — the "cannot accept" sentence renders twice (`task-side-panels.tsx:125` +
  Current-state `:721`). Give it one owner (the Current-state panel); `GithubTrace` carries only
  the GitHub fact. Test: `task-detail-components.test.tsx`.
- **C8** — move Scheduled re-runs below Execution profile and collapse the form behind a
  disclosure; render expanded only when a schedule exists (`task-detail-page.tsx:560-598`).

**Files:** `decision-packet.tsx` (primary), `accept-confirm.tsx`, `execution-profile.tsx`,
`task-detail-page.tsx`, `task-detail-hooks.ts`, `task-side-panels.tsx`, `task-main-sections.tsx`
*(Spec 1 run-operator submit `:536`)*, `app/routes/project.task.tsx` *(Spec 1/2 route arms)*.
**Tests:** `task-detail-route.server.test.ts`, `task-disposition.test.tsx`,
`accept-confirm.test.tsx`, `task-detail-components.test.tsx`.
**SHARED FILES (sequence):** `task-main-sections.tsx` also in **C-VOCAB** (hero pill swaps) →
**C-GOV-UI first**; `accept-confirm.tsx` also in **C-BOARD** (D3 lift) → **C-GOV-UI first**;
`project.task.tsx` also in **C-NOTIF** (F20-11 loader) → **C-GOV-UI first**. **Validation:**
PREVIEW (built) for copy/layout.

---

### C-VOCAB · Pill & readiness vocabulary (one slot, one meaning)
Sole owner of `app/ui/pill.tsx`. Depends on **C-GOV-SERVER** Phase D (the `acceptance` frontmatter
field) for §5c display.

- **N20-14 display half / C2** (nit + coherence, ⇄ §5c) — add `bypassed: "accepted · gate
  bypassed"` to `VALIDATION_DISPLAY` (`pill.tsx:96`, `risk`-toned) and a `deriveValidation`
  escape (`task-file.schema.ts:615` `if (fm.acceptance === "forced") return "bypassed"`);
  **C2** generalises: extend the archived-only live-obligation-pill withdrawal
  (`task-main-sections.tsx:172-180`) to **any terminal/accepted** task, reusing the
  `ArchivedPill` slot. Tests: `task-file.schema.test.ts`, `board-page.test.tsx` (card chip),
  `task-detail-components.test.tsx` (detail pill). *(`deriveValidation` lives in
  `task-file.schema.ts`, edited in Phase D's file — sequence within: Phase D adds the field,
  C-VOCAB adds the display arm. Same file → **C-GOV-SERVER first**, C-VOCAB second.)*
- **C3** — give "agent working" its own slot instead of suppressing the `input_required`
  readiness pill during a live run (`task-main-sections.tsx:172-177`); make the hero match the
  card's readiness/wait-tag split.
- **C5** — the readiness chip must self-label (icon / "readiness:" affordance) so "Ready ready"
  can't render; or the stage chip carries a stage glyph. (`pill.tsx` + a class in `app.css` —
  hand the CSS to **C-CSS-LAYOUT**, which owns `app.css`.)
- **C12** — an unrecognised readiness value must fall back to a neutral "unknown" pill, never
  green `ready` (`pill.tsx:~68-98`); the diagnostics panel carries the reason. Test:
  `task-file.schema.test.ts` / a pill unit.
- **C4** — collapse the five noun phrases for "a human owes something" to one-per-scope
  ("waiting on you" (viewer) / "waiting on a human" (project)), including the task rail which
  never personalises. Touches `task-main-sections.tsx`, `task-side-panels.tsx`,
  `review-page.tsx`, and the board subtitle (`board-page.tsx` — hand that string to **C-BOARD**).

**Files:** `app/ui/pill.tsx` (primary), `task-main-sections.tsx` *(shared w/ C-GOV-UI)*,
`task-side-panels.tsx` *(shared w/ C-GOV-UI)*, `review-page.tsx`, `app/schemas/task-file.schema.ts`
*(shared w/ C-GOV-SERVER)*.
**Tests:** `task-file.schema.test.ts`, `board-page.test.tsx`, `task-detail-components.test.tsx`.
**SHARED FILES (sequence):** after **C-GOV-UI** (`task-main-sections.tsx`, `task-side-panels.tsx`)
and after **C-GOV-SERVER** (`task-file.schema.ts`). Hands `board-page.tsx` (C2/C3 card, C4 subtitle)
and `app.css` (C5 class) to their owners. **Validation:** PREVIEW.

---

### C-BOARD · Board acceptance ceremony, announcements, card health
Sole owner of `app/features/board/board-page.tsx`. Depends on **C-GOV-UI** (`accept-confirm.tsx`
lift) and **C-VOCAB** (pill exports).

- **D3** (HIGH, ruling 14 + 53) — lift `AcceptConfirm` into a shared component both surfaces
  render, replacing the forked `AcceptOnBoardConfirm` (`board-page.tsx:~800-960`) so the board
  ceremony names merge target, delivered revision sha, verdict attribution, and no-change
  disposition. Test: `board-page.test.tsx`.
- **D9** (MED) — add a board-owned polite `aria-live` region announcing move requested / moved
  to `<stage>` / refused (covers the server 409 on an off-boundary move). Test: `board-page.test.tsx`.
- **C2/C3 board card** — the card-side of the accepted-pill withdrawal (C2) and the readiness/
  agent-working slot (C3) land here (board card, `board-page.tsx:~460-474`), using the pill
  changes from C-VOCAB. Test: `board-page.test.tsx`.

**Files:** `board-page.tsx` (primary), `accept-confirm.tsx` *(shared w/ C-GOV-UI)*.
**Tests:** `board-page.test.tsx`.
**SHARED FILES (sequence):** after **C-GOV-UI** and **C-VOCAB**. **Validation:** PREVIEW.

---

### C-CONTINUITY · Project continuity onto the card / row / filter (D4)
D4 is a defect (state that means one thing must appear everywhere it applies) — **in scope** per
R20-5 (it is not one of the held D10/D11 panel-state features). It is structural: continuity is
not a projected task field.

- **D4** (MED-HIGH) — project `continuity` as a task field so it reaches the board card, the
  review queue row, and a board filter (the "degraded continuity" filter the spec names). Touches
  the projection (`rebuilder.server.ts`, `app/shared/mapping/task.server.ts`), the board card +
  filter (`board-page.tsx`), and the review row (`review-page.tsx`); the panel itself
  (`continuity-recovery.tsx`) is unchanged. Tests: projection tests + `board-page.test.tsx`.

**Files:** `rebuilder.server.ts` *(shared w/ C-GOV-SERVER §5c)*, `task.server.ts` *(shared)*,
`board-page.tsx` *(shared w/ C-BOARD)*, `review-page.tsx` *(shared w/ C-VOCAB C4)*.
**SHARED FILES (sequence):** after **C-GOV-SERVER** (projection field), after **C-BOARD** /
**C-VOCAB** (board + review). This is the most cross-cutting UI item — schedule it late in the
UI band. **Validation:** PREVIEW + a projection unit.

---

### C-AGENTS · Agents page = policy truth (autonomy-aware, shared vocabulary)
Sole owner of `app/features/agents/agents-page.tsx` + `agents-query.server.ts`. Depends on
**C-GOV-SERVER** Phase A (model availability) and **C-SPECIALIST-MODE** (capability modes).

- **F20-9 / D1** (HIGH, **R20-7**) — make `capabilitiesToActionLabels`
  (`agents-query.server.ts:100-128`) apply the autonomy ceiling the way it already applies
  `applyVerdictOutcomeGate`, so a supervised operator's "Accept completion into Done" renders
  gated/conditional, not "Acts directly" — mirroring the runtime gate
  (`operator-actions.server.ts:2580`, **read-only reference, not edited here**). Second half: the
  Agents card carries the Policy page's reconciling note (`agents-page.tsx:705`). Tests:
  `agents-query.server.test.ts`, `agents-page.test.tsx`.
- **F20-16 agents half** (MED) — correct the `/agents` read-only deny note
  (`agents-page.tsx:1260`) to name the real grant/tier (gated on `manage-agents = [A]`,
  `rbac.ts:80`). *(The four settings-page deny notes are C-PROJECT-SETTINGS; the policy-page one
  is C-WORKFLOW-POLICY — co-owned across three clusters, split by file.)*
- **F20-4 badge** (Spec 3 client half) — `agents-query.server.ts:303` adds
  `modelUnavailable`; render it in `agents-page.tsx`; the model-catalog route + profile modal
  (`resources.model-catalog.ts:19-25`, `create-profile-modal.tsx:398-413/983-990`) disable +
  explain a marked model. Tests: `model-catalog-route.server.test.ts`, `agents-page.test.tsx`.
- **F20-20** (MED) — record the autonomy change (and the direct-accept grant) explicitly in the
  audit details + toast (`agent-profile-actions.server.ts:578-595`) instead of the generic
  `project.agent_profile.updated`. Test: `agents-route.server.test.ts` / a profile-actions unit.
- **C10** — route the Agents-page run/engagement status strings through the shared pill mapper
  instead of raw text (`agents-page.tsx`).
- **C11** — finish the "delivering agent" rename on the Agents page (drop "SPECIALIST PROFILES" /
  "New specialist profile"), or record the profile-vs-engagement split on the page.

**Files:** `agents-page.tsx` + `agents-query.server.ts` (primary),
`app/features/agents/create-profile-modal.tsx`, `app/routes/resources.model-catalog.ts`,
`app/features/agents/agent-profile-actions.server.ts`, `app/features/policy/policy-data.ts`
*(shared w/ C-WORKFLOW-POLICY for the F20-9 exception note)*.
**Tests:** `agents-query.server.test.ts`, `agents-page.test.tsx`,
`model-catalog-route.server.test.ts`, `agents-route.server.test.ts`.
**SHARED FILES (sequence):** `policy-data.ts` after **C-WORKFLOW-POLICY**; depends on
C-GOV-SERVER + C-SPECIALIST-MODE. **Validation:** PREVIEW (cards/badges).

---

### C-SPECIALIST-MODE · Specialists act directly or are withheld (R20-6) + seed model (R20-8)
Sole owner of `app/shared/capabilities.ts` and `app/server/seed/agent-catalog.server.ts`.
Independent of the spine (disjoint files) → parallel-safe with C-GOV-SERVER.

- **F20-21** (MED, **R20-6**) — remove `coerceSpecialistCapabilityMode`'s silent
  `recommend → direct` widening (`capabilities.ts:316-318`) so file = enforcement = display;
  make the seed honest — write `direct` (not `recommend`) for the specialist grants
  (`agent-catalog.server.ts:135` Developer, `:158` Reviewer). Operator keeps its real
  `recommend`. Tests: `capability-catalog.test.ts`, `agent-catalog.server.test.ts`.
- **R20-8** (seed default) — the seeded Developer's Codex model becomes `gpt-5.6-terra`
  (`agent-catalog.server.ts`). Test: `agent-catalog.server.test.ts`.

**Files:** `app/shared/capabilities.ts`, `app/server/seed/agent-catalog.server.ts`.
**Tests:** `capability-catalog.test.ts`, `agent-catalog.server.test.ts`.
**SHARED FILES:** none (F20-16 only *reads* `capabilities.ts:136`). **Validation:** unit.

---

### C-WORKFLOW-POLICY · Policy page + transition boundaries + workflow audit
Sole owner of `app/features/policy/policy-page.tsx`, `policy-actions.server.ts`, and
`app/server/projections/activity-feed.server.ts`.

- **F20-19** (MED) — state the project's configured operator autonomy on the Policy page so the
  human-only-Done conditional reads as live or not (`policy-page.tsx`, `policy-data.ts`).
- **F20-9 policy note** (co-owned) — the always-human "Transition a task to Done" exception note
  is the one the Agents card borrows; the canonical copy lives in `policy-data.ts:61-76` /
  `policy-page.tsx:516-527`. Keep `policy-data.ts` the single source; C-AGENTS consumes it.
- **F20-16 policy half** — the Policy page already names the grant correctly
  (`policy-page.tsx:457`); verify and leave as the reference the other surfaces are corrected to.
- **F20-26** (LOW) — recompute `rule.by` via `defaultTransitionBy` (`transitions.ts:55-65`,
  read-only) on every boundary change in `setTransitionBoundary`
  (`policy-actions.server.ts:199-217`) so the row stops self-contradicting. Test:
  `policy-route.server.test.ts`.
- **N20-9** (nit) — resolve raw stage ids to names in the boundary audit detail
  (`policy-actions.server.ts:230-237`). Test: `activity-feed.server.test.ts`.
- **F20-27 renderer half / F20-13 audit render** — read `d.name` on `project.stage.removed`
  and print the stage name (`activity-feed.server.ts:200-205/212`); when a structural stage edit
  retightens a hop, the disclosure text is authored here. *(The writer that records the name on
  `project.stage.added`/`removed` is C-PROJECT-SETTINGS — co-owned, split by file.)* Test:
  `activity-feed.server.test.ts`.
- **N20-7 doc** — document in the Policy footnote / task Permissions rail that an owner may also
  resolve non-acceptance packet options (the C-GOV-SERVER Phase E behavior).

**Files:** `policy-page.tsx` + `policy-actions.server.ts` + `activity-feed.server.ts` (primary),
`policy-data.ts` *(shared w/ C-AGENTS)*, `app/shared/workflow/transitions.ts` *(read-only for
F20-26/F20-13 — not edited)*.
**Tests:** `policy-route.server.test.ts`, `policy-page.test.tsx`, `activity-feed.server.test.ts`.
**SHARED FILES (sequence):** `policy-data.ts` before **C-AGENTS**. `activity-feed.server.ts` is
disjoint from C-PROJECT-SETTINGS's `settings-actions.server.ts`, so F20-13/F20-27's two halves
can proceed in parallel (coordinate the audit `details` shape between them). **Validation:** unit
+ PREVIEW for the Policy page.

---

### C-PROJECT-SETTINGS · Project settings actions: invites, repo verification, stage writes, deny notes
Sole owner of `app/features/project-settings/settings-actions.server.ts` +
`app/features/project-settings/settings-page.tsx`.

- **F20-12** (MED) — the Members-card invite mints a passwordless account that can never sign in
  yet shows healthy. Give the invite path the same temp-password ceremony as Allow-access (or
  refuse + point at it) (`settings-actions.server.ts:604-652`, `user-admin.server.ts:76-106`),
  and make `statusOf` (`org-users.server.ts:83-89`) surface a passwordless local account as
  not-yet-usable. Tests: `settings-actions.server.test.ts`, `ghost-members.server.test.ts`.
- **N20-6** (nit) — retoast "Added `<email>` … joins as Viewer" (no mailer)
  (`settings-actions.server.ts:652`).
- **F20-14** (MED) — run the Repair repo probe at **create** time (`settings-actions.server.ts:299-330`
  `repairProjectRepo`; wire the same probe into `project-create.server.ts`). Test:
  `settings-route.server.test.ts` / `project-create.server.test.ts`.
- **F20-15** (MED) — gate the repair (and the F20-14 create probe) on
  `repoWritable(permissions)` (already computed at `pat-validator.server.ts:232-240`), not just
  `res.ok`. Test: `settings-route.server.test.ts`.
- **F20-16 settings half** (MED) — correct the four read-only deny notes
  (`settings-page.tsx:114/791/1178`, gated on `canEditPolicy` `:1483`) to name the real grant
  ("Edit workflow & policy") and the real tier (project admin). Test: `settings-page.test.tsx`.
- **N20-11** (nit) — the new-project repo field's hard-coded `akin-ozer/` prefix mangles an
  owner-qualified entry; say the owner is fixed by the connection (new-project field in the
  create surface). Test: `settings-page.test.tsx` / create-page test.
- **F20-27 writer half / F20-13 disclosure half / N20-10** — record the stage **name** on
  `project.stage.added` (`settings-actions.server.ts:447-453`) so the renderer can print it; the
  remove path already records `{ name }` (`:526-533`); disclose the composite boundary tightening
  in the remove toast + audit (F20-13); store a **hex** (not `var(--yellow-dark)`) in
  `NEW_STAGE_COLORS` (`:63-68`) so the canonical project.md holds no CSS token (N20-10). Tests:
  `settings-actions.server.test.ts`.

**Files:** `settings-actions.server.ts` + `settings-page.tsx` (primary),
`app/server/auth/user-admin.server.ts`, `app/server/org/org-users.server.ts`,
`app/features/home/project-create.server.ts` *(shared w/ C-DATAROOT — after it)*,
`app/server/secrets/pat-validator.server.ts` *(read-only)*.
**Tests:** `settings-actions.server.test.ts`, `settings-route.server.test.ts`,
`ghost-members.server.test.ts`, `settings-page.test.tsx`.
**SHARED FILES (sequence):** `project-create.server.ts` after **C-DATAROOT**. Its stage-audit
writer half pairs with C-WORKFLOW-POLICY's renderer half (different files). **Validation:** unit +
PREVIEW; F20-12 has a **live specimen** (`probe.nobody@viberr.dev` still exists) worth a live check.

---

### C-GITHUB · GitHub trace card honesty + PR body link
Sole owner of `app/features/github/github-view.tsx`.

- **F20-23** (LOW) — the Execution-branches row renders a bare `#162` pill for a closed-not-merged
  PR; render a state word ("closed") like the merged row does. Test: `github-view.test.tsx`.
- **F20-24** (LOW) — "Archive & delete branch (discard work)" deletes only the remote ref; the
  local commit survives and Restore re-offers "Deliver branch & open PR". Either delete the local
  branch too (reuse `discardLocalTaskBranch` from C-GOV-SERVER Phase C) or narrow the summary and
  disclose that restore can re-deliver. Test: `github-view.test.tsx`.
- **F20-25** (LOW) — restoring an archived+withdrawn task strands it on "Waiting on: Human
  decision"; on restore, re-open the withdrawn question or clear the Waiting-on-Human state; and
  surface "branch deleted on remote" outside the timeline. Test: `github-view.test.tsx` /
  `archive-readonly.server.test.ts`.
- **N20-4** (nit, **§5a**) — add `appOrigin(): string | null` to `env.server.ts`; `composePrBody`
  (`pr-open.server.ts:42/82-91`) omits the "Viberr task" link and writes the plain store-relative
  key when it is null (a link that 404s on github.com is worse than none). Test:
  `pr-open.server.test.ts` (rewrite `:86-90`).

**Files:** `github-view.tsx` (primary), `app/server/github/pr-open.server.ts`,
`app/server/config/env.server.ts`.
**Tests:** `github-view.test.tsx`, `pr-open.server.test.ts`.
**SHARED FILES (sequence):** F20-24's local-discard reuse depends on **C-GOV-SERVER** Phase C
(`discardLocalTaskBranch`); the archive/restore state lives partly in the archive path
(`task-actions.server.ts`) — if F20-24/25 need a server edit there, sequence after C-GOV-SERVER.
**Validation:** unit + PREVIEW.

---

### C-SEARCH · Command palette (⌘K) ranking, labelling, coverage
Sole owner of `app/features/shell/command-search.server.ts`.

- **F20-28** (LOW) — add an exact-key/prefix rank boost so a full task key ranks first
  (`command-search.server.ts:111`, currently `ORDER BY updated_at DESC` only). Test:
  `command-search.server.test.ts`.
- **F20-29** (LOW) — label archived project hits like archived task hits (`projectHits` sets
  `sub: p.repo ?? p.slug` and drops the `archived` flag it already has in
  `home-query.server.ts:61/234`). Test: `command-search.server.test.ts`.
- **F20-30** (LOW) — register the palette at a layout covering `/profile`, `/notifications`,
  `/org/settings` (`routes.ts` + a shared layout; `useCommandPalette` currently imported only by
  `home-page.tsx`/`topbar.tsx`), or correct the "⌘K is ONE shortcut app-wide" copy
  (`home-page.tsx:85`).

**Files:** `command-search.server.ts` (primary), `app/features/home/home-query.server.ts`,
`app/routes.ts`, `app/features/shell/topbar.tsx`, `app/features/home/home-page.tsx`
*(F20-30 copy — shared w/ C-MISC-COPY C13)*.
**Tests:** `command-search.server.test.ts`.
**SHARED FILES (sequence):** `home-page.tsx` shared w/ **C-MISC-COPY** (C13). **Validation:**
unit + PREVIEW for the app-wide registration.

---

### C-NOTIF · Task-page notification auto-read (F20-11)
- **F20-11** (MED) — the task loader's `markTaskNotificationsSeen`
  (`project.task.tsx:120-131`, logic in `notifications.server.ts`) fires on every SSE `.data`
  revalidation, so a parked background tab silently eats notifications and the bell never badges.
  Mark only on a genuine document/navigation load (not `.data` revalidations) and/or gate on
  document visibility, keeping the monotonic/idempotent contract. Test: a `notifications.server`
  unit + a `project.task` loader test.

**Files:** `app/routes/project.task.tsx` *(shared w/ C-GOV-UI + C-GOV-SERVER)*,
`app/server/projections/notifications.server.ts`.
**SHARED FILES (sequence):** `project.task.tsx` after **C-GOV-UI**. **Validation:** unit;
the parked-tab behavior is a **CONTAINER** live check.

---

### C-CSS-LAYOUT · Layout & CSS (app.css owner)
Sole owner of `app/app.css` (one stylesheet; `app.css.test.ts` is the integrity gate).

- **D2** (HIGH) — at ≤1100px the task page stacks Current-state + the primary "Accept
  completion → Done" button below the entire timeline (`app.css:1004-1013/3974-3980`).
  Recommended fix: a CSS `order` swap at the 1100px breakpoint (cheap, preserves source order for
  screen readers). If the owner wants the screen-reader order fixed too, that is a DOM reorder in
  `task-detail-page.tsx` (then co-owned with C-GOV-UI). Default to CSS-only.
- **C9** — keep one GitHub-card header identity and let the pill row wrap rather than clip
  ("1/2 checks faili" at 1440px) — `app.css` for the card/pill-row rules (plus a header tweak in
  `github-view.tsx`, co-owned with C-GITHUB).
- **N20-13** (nit) — the PageOverlay `.overlay-x` close button floats over scrolled right-column
  content (`app.css` + `app/ui/page-overlay.tsx`). Test: `app.css.test.ts` stays green.
- **C5 CSS** — the stage-chip glyph / readiness self-label class from C-VOCAB.

**Files:** `app/app.css` (primary), `app/ui/page-overlay.tsx`, `github-view.tsx`
*(shared w/ C-GITHUB)*.
**Tests:** `app.css.test.ts` (integrity/contrast gate must stay green).
**SHARED FILES (sequence):** `github-view.tsx` coordinate with C-GITHUB. **Validation:** PREVIEW
at the named viewports (1100px, 1440px).

---

### C-CONFIRM · Confirmation coverage & grammar (D6, C6)
- **D6** (MED-HIGH) — bring single-click consequential/destructive actions up to the confirm bar:
  remove workflow stage, remove project member, release another user's task ownership, cancel a
  scheduled re-run, dismiss an operator recommendation, interrupt a live run. Proposal: anything
  removing a person/stage/queued action gets a confirm naming the outcome; reversible + self-scoped
  stays one click. *(Note: `release-confirm.tsx` and `archive-confirm.tsx` already exist — audit
  which of the six are truly unconfirmed before building; some may be partially done.)*
- **C6** — parameterise the shared `ConfirmDelete` (`app/features/org-settings/mini-modal.tsx`,
  used by `sso-panel`/`connections-panel`/`resources-panel`/`users-panel`) so its confirm label
  names the outcome and states the blast radius ("3 agent profiles reference this knowledge base").

**Files:** `mini-modal.tsx` (primary), the six D6 control sites across `task-detail` +
`project-settings` *(shared w/ C-GOV-UI + C-PROJECT-SETTINGS)*.
**SHARED FILES (sequence):** after **C-GOV-UI** and **C-PROJECT-SETTINGS** (it touches their
files). **Validation:** PREVIEW.

---

### C-TOASTS · Failure-toast honesty sweep (D5)
- **D5** (MED-HIGH) — ~10 call sites push a refusal/error through the default (success) toast
  kind, rendering a refusal under a green check, against a written decisions.md rule with no
  check behind it. Sweep the sites to pass an explicit error kind AND add a gate (a lint over
  toast call sites, or a test) so a new one goes red. This touches files owned by many clusters
  (each a one-line kind arg) → **runs last** to avoid churn.

**Files:** ~10 toast call sites across features + a new lint/test gate.
**SHARED FILES:** many, one-line each → schedule after the structural clusters. **Validation:**
PREVIEW spot-check + the new gate.

---

### C-EMPTY-STATES · Empty-state copy sweep (D8)
- **D8** (MED) — ~13 bare-label empty states (the four org-resources tabs are the worst cluster;
  the attachments panel renders **nothing** when empty). Bring them to the spec bar (what's
  absent, why it matters, next action). `attachments-panel.tsx` gets a real empty state.

**Files:** `attachments-panel.tsx`, the org-resources tabs (`resources-panel.tsx`/`resource-rows.tsx`
*shared w/ C-MCP*), and the remaining ~10 surfaces.
**SHARED FILES (sequence):** resources tabs after **C-MCP**. **Validation:** PREVIEW.

---

### C-MISC-COPY · Isolated copy/input nits
- **N20-1** (nit) — login email input `type="text"` → `type="email"` (`app/routes/login.tsx`).
- **N20-12** (nit) — the profile Email hint promises an admin edit it neither offers nor links;
  link the Org settings → Users & access → Edit destination or say where
  (`app/features/profile/profile-page.tsx:164-166`).
- **C13** — the home store-maintenance strip describes "the board" on a page with none; say
  "projects and boards are a projection…" (`home-page.tsx`).

**Files:** `login.tsx`, `profile-page.tsx`, `home-page.tsx` *(shared w/ C-SEARCH F20-30)*.
**SHARED FILES (sequence):** `home-page.tsx` coordinate with C-SEARCH. **Validation:** PREVIEW.

---

### C-DOCS · Canon hygiene (D13) — docs only, no app code
- **D13** — add the missing PRD/NFR8 amendment note (`prd.md:278`, required by ruling 44);
  strike or fund NFR14's unmeasured 10-second budget; correct ruling 75's
  `task-attachment.tsx` → `.ts` path in `decisions.md`. Fully independent (no app code) →
  parallelizable anywhere. *(The ruling-7 nine→ten count for `discard_branch` is edited by
  C-GOV-SERVER Phase C, not here.)*

**Files:** `planning/planning-artifacts/prd.md`, `docs/architecture/decisions.md`.
**Validation:** none (docs).

---

## 2. Hot-file ownership (the serialization bottlenecks)

Five files carry the bulk of the findings. Each is assigned to **one** owning cluster that lands
all of its findings together; every other cluster that must touch it is **sequenced after** the
owner (or hands its edit to the owner). This is what keeps the rest of the graph parallel.

| Hot file | Findings on it | Owning cluster | Recommendation |
|---|---|---|---|
| `app/server/tasks/task-actions.server.ts` | F20-5, F20-6, F20-4, N20-14(§5c), F20-18/N20-7 | **C-GOV-SERVER** | **ONE owner.** Land Specs 1+2+3-server + §5c-server + owner-exception as ordered phases A→E. Never split across parallel clusters — every edit rewrites `resolvePacket`/the failure pipeline. |
| `app/server/runtimes/operator-run.server.ts` | F20-5, F20-6, F20-4 | **C-GOV-SERVER** | **ONE owner**, same cluster as `task-actions` (they co-restructure the packet/escalation flow). |
| `app/server/org/resources.server.ts` | F20-7, F20-8(EPIPE), F20-22, F20-2, N20-2, F20-10 | **C-MCP** | **ONE owner.** All six are the MCP probe/spawn pipeline; landing them together avoids six passes over the same spawn code. |
| `app/features/task-detail/decision-packet.tsx` | F20-17, F20-18, N20-8, C7, C14, F20-6(discard confirm) | **C-GOV-UI** | **ONE owner.** All are the packet card; C1/C8 in the same cluster keep the task-detail feature coherent. |
| `app/ui/pill.tsx` | N20-14(display), C2, C3, C5, C12 | **C-VOCAB** | **ONE owner.** The pill/readiness vocabulary is one mapping; split edits would fight over `VALIDATION_DISPLAY`/the readiness lookup. |

Secondary hot files, each also single-owned: `app/features/project-settings/settings-actions.server.ts`
→ **C-PROJECT-SETTINGS**; `app/features/agents/agents-page.tsx` (+ `agents-query.server.ts`) →
**C-AGENTS**; `app/shared/capabilities.ts` → **C-SPECIALIST-MODE**; `app/features/board/board-page.tsx`
→ **C-BOARD**; `app/app.css` → **C-CSS-LAYOUT**; `app/routes/project.task.tsx` → **C-GOV-UI /
C-GOV-SERVER** with **C-NOTIF** sequenced after.

Two shared low-level files force cross-band ordering: `app/server/secrets/git-output-redact.server.ts`
(**C-MCP** F20-7 → **C-GOV-SERVER** `redactProviderText`) and `db/migrations/0001_baseline.sql`
(**C-MCP** Spec 4 columns + **C-GOV-SERVER** `model_availability` — one migration, two clusters
appending). **C-MCP goes first on both.**

---

## 3. Shared-file dependency edges (must not run concurrently)

```
C-MCP            ──git-output-redact, 0001_baseline──▶ C-GOV-SERVER
C-DATAROOT       ──project-create.server──────────────▶ C-PROJECT-SETTINGS
C-GOV-SERVER     ──task-file.schema, rebuilder, task.server──▶ C-VOCAB (§5c display)
C-GOV-SERVER     ──rebuilder, task.server──────────────▶ C-CONTINUITY (D4 field)
C-GOV-SERVER     ──discardLocalTaskBranch, archive path─▶ C-GITHUB (F20-24/25)
C-GOV-UI         ──task-main-sections, task-side-panels─▶ C-VOCAB
C-GOV-UI         ──accept-confirm──────────────────────▶ C-BOARD (D3 lift)
C-GOV-UI         ──project.task────────────────────────▶ C-NOTIF
C-VOCAB          ──pill.tsx (exports), board-card strings▶ C-BOARD
C-VOCAB / C-BOARD──board-page, review-page─────────────▶ C-CONTINUITY
C-WORKFLOW-POLICY──policy-data───────────────────────▶ C-AGENTS
C-GOV-UI, C-PROJECT-SETTINGS──their control sites──────▶ C-CONFIRM, C-TOASTS, C-EMPTY-STATES
C-SEARCH         ──home-page──────────────────────────▶ C-MISC-COPY
C-GITHUB         ──github-view────────────────────────▶ C-CSS-LAYOUT (C9 header)  [coordinate]
```

Everything not connected by an edge above has a disjoint file-set and may run in parallel.

---

## 4. Ordered execution schedule (topological)

HIGH-severity/security first, then the governance spine, then UI, then sweeps. Clusters listed on
the same band have disjoint file-sets and run in parallel.

**Band 0 — HIGH, security & availability (parallel; disjoint):**
1. **C-MCP** — F20-7 (secret leak) is the highest-priority single fix; also F20-8-EPIPE, F20-22,
   F20-2, N20-2, F20-10.
2. **C-CRASH-LOCK** — F20-8 silent-death + self-lockout.
3. **C-DATAROOT** — F20-1/F20-3 (fault-injection experiment gates the fix shape).

**Band 1 — governance spine + independent seed (parallel where disjoint):**
4. **C-GOV-SERVER** — Specs 1+2+3-server + §5c-server + owner-exception (after C-MCP: shares
   `git-output-redact`, `0001_baseline`). Ordered phases A→E internally.
5. **C-SPECIALIST-MODE** — F20-21/R20-6 + R20-8 seed (disjoint from the spine → parallel with #4).
6. **C-WORKFLOW-POLICY** — F20-19, F20-26, N20-9, F20-27-renderer, F20-9-note (disjoint from the
   spine; `policy-data` feeds C-AGENTS → must precede it).
7. **C-PROJECT-SETTINGS** — F20-12/14/15/16-settings, N20-6/11, F20-27-writer, N20-10, F20-13-disclosure
   (after C-DATAROOT: shares `project-create`).
8. **C-SEARCH** — F20-28/29/30 (disjoint → parallel).
9. **C-DOCS** — D13 (docs only → parallel anywhere).

**Band 2 — governance & agents UI (after the spine):**
10. **C-GOV-UI** — Spec 1/2 UI, F20-17, F20-18-UI, N20-8, C7, C14, C1, C8 (after C-GOV-SERVER).
11. **C-AGENTS** — F20-9/D1/R20-7, F20-16-agents, F20-4-badge, F20-20, C10, C11 (after C-GOV-SERVER
    + C-SPECIALIST-MODE + C-WORKFLOW-POLICY).
12. **C-GITHUB** — F20-23/24/25, N20-4 (after C-GOV-SERVER for the discard/archive reuse).

**Band 3 — vocabulary & board (after task-detail UI):**
13. **C-VOCAB** — N20-14-display/C2, C3, C4, C5, C12 (after C-GOV-UI + C-GOV-SERVER).
14. **C-BOARD** — D3, D9, C2/C3-card (after C-GOV-UI + C-VOCAB).
15. **C-CONTINUITY** — D4 (after C-GOV-SERVER + C-BOARD + C-VOCAB; most cross-cutting UI item).
16. **C-CSS-LAYOUT** — D2, C9, N20-13, C5-CSS (after C-GITHUB for the card header; otherwise free).
17. **C-NOTIF** — F20-11 (after C-GOV-UI: shares `project.task`).
18. **C-MISC-COPY** — N20-1, N20-12, C13 (after C-SEARCH: shares `home-page`).

**Band 4 — global sweeps (last, they touch many cluster-owned files):**
19. **C-CONFIRM** — D6, C6 (after C-GOV-UI + C-PROJECT-SETTINGS).
20. **C-EMPTY-STATES** — D8 (after C-MCP for the resources tabs).
21. **C-TOASTS** — D5 + the new gate (very last; one-line kind args across many files).

**Band 5 — live-validation wave (single container rebuild, then targeted checks):**
Rebuild the production image (`docker compose up -d --build`) once all code lands, then verify the
**CONTAINER**-flagged items live: F20-7 short-credential redaction (screenshot re-shot); F20-8
kill/restart (no silent death, no self-lockout); F20-2 zombie reaping (`ps -ef`, expect no
`<defunct>` after boot); F20-10 crashed-MCP-spawn run disclosure; N20-2 cold-`npx` warm-up row;
F20-1 create-project under a hostile mount (watchdog fires, server keeps serving); F20-4 a real
Codex run against a rejected model (provider sentence in packet + timeline, model marked
unavailable); F20-11 parked-tab notification behavior; F20-12 the live `probe.nobody@viberr.dev`
specimen. UI/copy clusters (Bands 2–4) are validated in the built **preview** as they land; only
the runtime/mount/process items need the rebuilt container.

---

## 5. Notes for the implementer

- **Canary every fix** by reverting it and watching the named test go red (the specs call out the
  specific canaries: F20-7 length-gate, Spec 1 `clearPacket`/manual-scoping, Spec 2 R19-8
  fail-closed, Spec 4 `heuristicWarmups < 1`, F20-8-EPIPE single-write-clean baseline).
- **decisions.md is edited in two places** — ruling-7 count (C-GOV-SERVER, discard_branch) and the
  ruling-75 path + NFR notes (C-DOCS). Coordinate so they don't both rewrite the same section; they
  touch different rulings, so a clean sequence (either order) is fine.
- **Co-owned findings** (both halves must land before "done"): F20-8 (C-MCP + C-CRASH-LOCK),
  F20-16 (C-PROJECT-SETTINGS + C-WORKFLOW-POLICY + C-AGENTS), F20-18/N20-7 (C-GOV-SERVER + C-GOV-UI
  + C-WORKFLOW-POLICY), F20-6 (C-GOV-SERVER + C-GOV-UI), F20-5 (C-GOV-SERVER + C-GOV-UI), N20-14/§5c
  (C-GOV-SERVER + C-VOCAB), F20-27/F20-13 (C-PROJECT-SETTINGS + C-WORKFLOW-POLICY), F20-4 (C-GOV-SERVER
  + C-AGENTS), N20-4 (C-GITHUB), C9 (C-GITHUB + C-CSS-LAYOUT).
- **HELD, out of scope** (R20-5): **D7** (Decision-Packet impact/confidence/severity fields),
  **D10/D11** (Continuity-panel escalated/paused states, execution-truth-strip continuity),
  **D12** (skeleton loaders). Do not build these; leave the spec-vs-app gap noted.
- **`tsc` + the full suite are required gates** (per prior-pass memory: `npm run build` ≠ typecheck).
  Each cluster lands green independently before the next dependent cluster starts.
