# Pass 20 — Findings ledger (consolidated)

Status legend: OPEN (needs fix), ASK (needs owner ruling), NOTED (minor/UX polish), FIXED, WONTFIX.

This is the single authoritative ledger for pass 20. It merges the main-session findings
(F20-1..F20-6, N20-1..N20-4) with the batch-1 live-run lanes, which independently numbered
their findings and therefore collided (multiple distinct "F20-7/8/9", plus lane-local
`F20-A..D`, `F20-N1`, `F20-P1/2`, `F20-S1/2/3`, `N20-A/B/C`, `N20-5`). Every batch-1 claim was
re-probed by the verifier lane and **none was refuted** — treat them as validated. Each new
finding below carries the lane + use-case it came from and, where useful, the lane-local label
it originally wore, so the raw journal (`batch1-journal.jsonl` / `batch1-raw.txt`) stays
cross-referenceable.

Two companion documents hold work that is **not** re-filed here: `PRD-ALIGNMENT.md` carries the
sanctioned-divergence inventory (List 1, 20 items), the suspected-drift list (List 2, D1–D13)
and the UX-coherence critique (List 3, C1–C14). Where a batch-1 finding corroborates a
PRD-ALIGNMENT item it is cross-referenced on the entry (F20-9 ⇄ D1; N20-14 ⇄ C2).

---

## Status table

| id | title | severity | fix spec? | owner decision? |
|---|---|---|---|---|
| F20-1 | Broken data-root mount spins the event loop, whole app down | HIGH | yes (FS 5d) | no |
| F20-7 | Sub-8-char MCP credential printed in plaintext into row error + toast + DB | HIGH | no | no |
| F20-8 | App-wide silent crash then self-lockout — a stale writer.lock bricks the container | HIGH | no | no |
| F20-9 | Supervised operator's card + matrix advertise "Accept completion → Done · Acts directly" the runtime refuses (⇄ D1) | HIGH | no | yes |
| F20-3 | Ghost-mount boot half-seeds the org (0 vs 3 resources) | MED | yes (FS 5d) | no |
| F20-4 | Codex model/account mismatch fails generic; provider's words buried | MED | yes (Spec 3) | no (ruled R20-3) |
| F20-5 | "…and unblock" recovery option HOLDS; packet accepts repeat confirms | MED | yes (Spec 1) | no (ruled R20-1) |
| F20-6 | Empty task branch + unflagged no-change completion strands acceptance | MED | yes (Spec 2) | no (ruled R20-2) |
| F20-10 | A declared org MCP server that fails to start contributes zero tools while every surface says "healthy" | MED | no | no |
| F20-11 | Task-page notification auto-read fires on background revalidation; a parked tab silently eats notifications, bell never badges | MED | no | yes |
| F20-12 | Project Members-card invite of an unknown email mints a passwordless account that can never sign in, shown as healthy | MED | no | no |
| F20-13 | Add→move→remove stage round trip permanently tightens a workflow boundary with no disclosure | MED | no | no |
| F20-14 | Project creation never verifies the repository (Repair does), so a typo'd repo is accepted silently | MED | no | no |
| F20-15 | The repair probe accepts a repo the credential can only READ — never checks push | MED | no | no |
| F20-16 | Four read-only deny notes tell a maintainer they hold an admin-only grant, citing an invented grant name | MED | no | no |
| F20-17 | A role that cannot resolve a packet is still shown fully interactive options with no reason | MED | no | no |
| F20-18 | A contributor-owner can be handed a packet where every option is forbidden, with no in-app way to clear their own task | MED | no | no |
| F20-19 | The Policy page never states the project's configured operator autonomy | MED | no | no |
| F20-20 | Granting full operator autonomy is audited as a generic profile update | MED | no | no |
| F20-21 | Specialist `recommend` grants are silently coerced to `direct`; canonical project.md disagrees with every rendered surface | MED | no | yes |
| F20-2 | Boot leaves defunct chromium zombies under pid 1 | LOW | yes (FS 5b) | no |
| F20-22 | A stdio MCP command that dies without printing drops its exit code/signal | LOW | no | no |
| F20-23 | The GitHub Execution-branches table never shows "closed" for a closed-not-merged PR | LOW | no | no |
| F20-24 | "Archive & delete branch (discard work)" deletes only the remote ref; the local commit survives and one click re-pushes it | LOW | no | no |
| F20-25 | Restoring a task whose packet was withdrawn by the archive strands it on "Waiting on: Human decision" | LOW | no | no |
| F20-26 | Changing a transition boundary leaves the `by` prose stale → self-contradicting Policy row | LOW | no | no |
| F20-27 | Stage add/remove audit rows drop the stage name (writer/renderer mismatch) | LOW | no | no |
| F20-28 | ⌘K does not rank an exact task-key match first | LOW | no | no |
| F20-29 | ⌘K leaves archived projects unlabelled while archived tasks are labelled | LOW | no | no |
| F20-30 | ⌘K is not registered app-wide (absent on /profile, /notifications, /org/settings) | LOW | no | no |
| N20-1 | Login email input is `type="text"` | nit | no | no |
| N20-2 | Cold npx MCP registration says "timed out after 20s", no warm-up | nit | yes (Spec 4) | no (ruled R20-4) |
| N20-3 | (reserved — no finding recorded under this id in the source material) | — | — | — |
| N20-4 | The PR body's "Viberr task" link is relative | nit | yes (FS 5a) | no |
| N20-5 | MCP name refusal quotes the slugified name the admin never typed | nit | no | no |
| N20-6 | "Invite sent to <email>" claims an email was sent though there is no mailer | nit | no | no |
| N20-7 | The owner exception is documented for acceptance but not for packet resolution | nit | no | no |
| N20-8 | Sibling deny notes phrase the same [A,M] tier two different ways | nit | no | no |
| N20-9 | The boundary audit row prints raw stage ids instead of names | nit | no | no |
| N20-10 | New stages persist a CSS token (`var(--yellow-dark)`) into the canonical project.md | nit | no | no |
| N20-11 | The new-project repo field silently mangles an owner-qualified entry | nit | no | no |
| N20-12 | The profile Email hint promises an admin edit it neither offers nor links | nit | no | no |
| N20-13 | The PageOverlay close button floats over scrolled right-column content | nit | no | no |
| N20-14 | The force-accept "awaiting verdict" validation chip survives the bypass (⇄ C2) | nit | yes (FS 5c) | no |

New findings that already have a fix spec: **1** (N20-14, via FIX-SPECS §5c). New findings that
**need** a spec: **33** (F20-7..F20-30 and N20-5..N20-13). The rest of the table's "yes" rows are
main-session findings already covered by FIX-SPECS Specs 1–4 and §5a/5b/5d.

---

## Owner rulings 2026-08-14 (pass 20)
- **R20-1 (on F20-5)**: Confirming ANY recovery option on a failure packet RESOLVES the packet
  (no further confirms accepted) and RE-QUEUES the operator automatically; option labels must
  say exactly what will happen; a repeat failure opens a NEW packet (fresh decision record).
- **R20-2 (on F20-6)**: `accept_completion` re-verifies the ACTUAL branch state — branch empty
  or missing routes into the no-change acceptance path (with disclosure) regardless of the
  agent's noChanges flag; the packet's discard option actually deletes the never-pushed local
  branch on confirm.
- **R20-3 (on F20-4)**: Both halves — extend the R19-13 surface-the-tool's-own-words rule to
  the Codex/Claude spawn-error pipe (redacted provider sentence into packet + timeline), AND
  validate model availability against the account (probe at save or first failure) marking
  unavailable models in the catalog.
- **R20-4 (on N20-2)**: A first-ever probe of an npx/bunx-style stdio command that times out is
  treated as visibly-installing: auto warm-up in the background, same 15-minute cap and polling
  row as the uvx path.
- **R20-5 (scope, 2026-08-15)**: THIS pass fixes **all** defects (F20-1..30, N20-1..14) AND all
  UX-coherence/drift items that are defects or inconsistencies (C1..C14, D2..D13). The only items
  HELD out of scope are pure never-built PRD features: **D7** (restore the 3 dropped Decision-Packet
  anatomy fields), **D10/D11** (the missing Continuity-panel states / Execution-truth continuity),
  **D12** (skeleton loaders). Everything else is a committed todo — no deferral, validate each.
- **R20-6 (on F20-21)**: Specialists only ever act **directly** or are **withheld** — drop
  `recommend` for the specialist kind. Make the seed honest (write `direct`, not `recommend`, in
  `agent-catalog.server.ts`) and REMOVE `coerceSpecialistCapabilityMode`'s recommend→direct silent
  widening so file = enforcement = display. Operator keeps its real `recommend`.
- **R20-7 (on F20-9 / D1)**: The capability display MIRRORS the runtime gate — make the Agents card
  + Capability-matrix bucketing **autonomy-aware**: under a supervised project, "Accept completion
  into Done" renders gated/conditional, not "Acts directly". The card must be policy-truth at a
  glance (extend `capabilitiesToActionLabels` to apply the autonomy ceiling the way it already
  applies `applyVerdictOutcomeGate`).
- **R20-8 (on F20-4 seed half)**: The seeded Developer's Codex model default becomes
  **`gpt-5.6-terra`** (the model this account actually runs). R20-3 (surface provider error +
  mark-unavailable) still ships so a future mismatch is honest, not generic.

# HIGH — security / data-loss / broken-core-flow

## F20-1 — Broken data-root mount spins the event loop and takes the whole app down · OPEN (resilience)
- **Seen live 2026-08-14.** The host `docker-data/` bind-mount source had been deleted while the
  container ran (clean-slate reset). The app booted fine on the ghost inode, login worked, the
  GitHub connection saved — then `create-project` pegged the main thread at ~20% CPU forever.
  `/resources/health` timed out, SSE died, the SIGUSR1 inspector could not even start (main
  thread never yields). No child processes, no outbound sockets — a pure in-process spin.
- Expected: a filesystem error in an action fails THAT action with an honest error; the server
  keeps serving. A watchdog for "action exceeded N seconds" would also have surfaced this.
- Repro note: after recreating `docker-data/` and restarting, the identical create succeeded in
  ~2s — the hang is environmental, but the failure MODE (silent app-wide hang) is the defect.
- Suspect surface: `createProjectFile`/data-root writes under a dead VirtioFS inode → error →
  retry/loop somewhere in the write or watcher path. Needs a forced-repro under a hostile mount
  before fixing (e.g. EIO/ESTALE fault injection around the project-file writer). Fix spec: §5d.

## F20-7 — A sub-8-char MCP credential is printed in plaintext into the row error, the toast, and the persisted `last_error` · OPEN (secret leak) — HIGH
- **Batch-1 lane A / UC-14 (lane-local "F20-7"); verifier CONFIRMED (code + screenshot pair).**
  Add an MCP server, stdio, whose command echoes a short credential, e.g. `node -e
  "console.error('CRED=' + process.env.MCP_CREDENTIAL); setTimeout(() => process.exit(2), 1500)"`
  with `MCP_CREDENTIAL = xy7Qk` (5 chars). The row renders `exited before responding — CRED=xy7Qk`
  and the DB row holds BOTH the sealed secret (`cred_ref = v1$…`) and its plaintext
  (`last_error = 'exited before responding — CRED=xy7Qk'`) — directly under the Add modal's promise
  "Encrypted at rest … Never shown again, and never in task timelines, comments, or audit records."
- Counter-case isolates the cause: editing the same credential to `LONGSECRET-7801-xyz` (19 chars)
  and re-testing renders `CRED=[redacted]`.
- Source: `app/server/org/resources.server.ts:869-873` (`withDetail` passes `{ token }` into
  `redactGitOutput`) → `app/server/secrets/git-output-redact.server.ts:63` gates the layer-1
  by-value scrub (applied at `:85`) on `opts.token.length >= MIN_TOKEN_LEN` with
  `MIN_TOKEN_LEN = 8`, so a value under 8 chars skips it; layer-3 `TOKEN_SHAPE_SOURCE` is only
  anchored prefixes (`gh[pousr]_`, `github_pat_`, `sk-`), which never matches a short arbitrary
  secret.
- Fix direction: scrub by value at ANY length, or refuse credentials under 8 chars at save
  (both, ideally). Evidence: `screenshots/uc/UC-14-8-short-credential-leak.png` vs
  `UC-14-9-long-credential-redacted.png`. Verifier caveat: the DB-half (plaintext beside
  `cred_ref`) is no longer re-verifiable — the probe row was deleted at 17:30:08Z — so it rests on
  the screenshot pair plus the confirmed code path.

## F20-8 — App-wide silent crash, then self-lockout: a crashed writer's lock bricks the container · OPEN (availability / data-loss) — HIGH
- **Batch-1 lane A notes (lane-local "F20-9"); verifier CONFIRMED, with one numeric correction
  (nine boot refusals, not eight).** Mid-run the whole deployment went down for ~2.5 minutes,
  affecting every lane. Three load-bearing halves:
- **(a) The death is silent.** The app process disappeared at `2026-08-14T17:16:33Z` with zero
  diagnostic output — `docker logs -t` goes straight from a `200` request line at `17:16:32.620`
  to the first restart's refusal at `17:16:33.892`, no stack trace, no FATAL line, no signal note.
  The fatal channel has the same weakness: `app/server/db/data-root-lock.server.ts:466-481`
  (`loudlyShutDownOnStolenLock`) calls `logger.error(...)` (`logger.server.ts:82` = an async
  `process.stdout.write` to a pipe) and then `process.exit(1)` on the next line, truncating that
  write.
- **(b) The restart cannot boot — self-lockout.** Nine consecutive boots printed "Refusing to
  boot: another Viberr process is already writing /data. Held by pid 1 on host viberr since
  2026-08-14T16:50:03.813Z." The app runs as pid 1 and compose pins the hostname, so
  `classifyLock` (`data-root-lock.server.ts:~236-252`) takes the `holder.hostname === self.hostname`
  branch and asks `isAlive(1)` — which in the restarted container is the asking process itself →
  verdict "held" → refuse, forever. The bootId discriminator only rescues the same-process HMR
  case. **Any crash that leaves `writer.lock` behind therefore bricks the deployment until a human
  deletes the file.** (RestartCount reached 11 before it happened to boot into a window where the
  predecessor was truly gone.)
- **(c) Not the MCP save.** The credentialed save was in flight at the first death (its row never
  reached the DB), but the SECOND death happened with no MCP activity at all, while VIB-3 operator
  runs and stage transitions fired. Both deaths cluster on operator-run/transition activity on
  VIB-3 — `run_V186s8HmiETU.jsonl`'s last line at `17:16:32.234Z` is the operator selecting
  `mcp__viberr__transition_stage` one second before death #1.
- **(d) A proven candidate mechanism** for the silent exit-1: an unhandled EPIPE on a piped
  child's stdin. `discoverStdioMcpTools`' `send()` (`app/server/org/resources.server.ts:911-917`)
  wraps only the SYNCHRONOUS `child.stdin?.write(...)` and never attaches an `'error'` listener,
  so a broken-pipe write surfaces as an uncaught exception (fatal to the server). Reproduced inside
  the container: `node repro/epipe-probe.js` printed `UNCAUGHT: EPIPE write EPIPE` on 5 of 40
  iterations (fast-exiting child + continued stdin writes); the single-write-only variant was clean
  120/120. Exposure is any path that writes to a spawned process's stdin after it may have exited —
  which includes the run pipeline's CLI children, not just this probe. Scripts: `repro/epipe-probe.js`,
  `repro/epipe-probe2.js`.
- Fix directions (owner follow-up from the lane): (1) attach an `'error'` handler wherever the app
  writes to a child's stdin; (2) add a process-level `uncaughtException`/`unhandledRejection` logger
  that flushes synchronously (`fs.writeSync(2, …)`) before exit so a death is never silent;
  (3) make `classifyLock` refuse to treat "pid 1 on my own hostname" as proof of a live predecessor
  (compare `/proc/1` start time, or auto-reclaim when the holder pid equals this process's own pid)
  so a crash cannot brick the container. Related but distinct: F20-1 (a hang, not a crash) and F20-2
  (pid-1 has no init to reap orphans); the compose `init: true` in §5b would help reaping but does
  NOT fix the lock self-lockout or the EPIPE crash. Needs its own spec.

## F20-9 — The supervised operator's capability card + matrix advertise "Accept completion → Done · Acts directly" that the runtime refuses · OPEN — HIGH · ASK
- **Witnesses: batch-1 lane C / UC-19 (its two "ASK" items) AND `PRD-ALIGNMENT.md` D1 (rated HIGH).
  Verifier CONFIRMED the code paths.** An operator profile holding `completion-for-acceptance: direct`
  on a project deployed **supervised** renders "Accept completion into Done" under **ACTS DIRECTLY**
  on both the Agents capability card and the Capability-matrix modal — authority the server will
  refuse. Live in `screenshots/uc/UC-19-01-capability-matrix.png`,
  `UC-19-06-supervised-card-still-direct-accept.png` (the main-session inventory
  `UC-19-06-run-control-ceiling.png` shows the ceiling copy where it DOES bind).
- Cause: the display buckets grants through `capabilitiesToActionLabels`
  (`app/features/agents/agents-query.server.ts:100-128`) applying exactly one gate —
  `applyVerdictOutcomeGate` — while the runtime gate for the same capability is
  `authority.autonomy !== "full" || gate(...) !== "direct"`
  (`app/server/tasks/operator-actions.server.ts:2580`). The display never applies the autonomy
  ceiling; the matrix mentions autonomy nowhere. This is the F15-06 defect class (the exact thing
  `applyVerdictOutcomeGate` exists to prevent) left unfixed one axis over — an admin reads the card
  as policy truth.
- Second half (same card): "Accept completion into Done" sits under ACTS DIRECTLY while "Transition
  a task to Done" sits under RESERVED FOR HUMANS, with no reconciliation. The Policy page carries
  exactly the note that resolves this (`policy-data.ts:61-76`, `policy-page.tsx:516-527`); the Agents
  page renders bare label lists (`agents-page.tsx:705`) and carries none.
- **ASK owner (per D1):** should the display gate mirror the runtime gate (autonomy-aware buckets,
  the way verdict outcomes are gated), or keep the raw grant and carry the Policy page's exception
  sentence inline — and should the always-human "Transition a task to Done" row carry its exception
  note on every surface that prints it, not just Policy?

---

# MED

## F20-3 — Ghost-mount boot half-seeds the org (0 agent resources vs 3) · NOTED, fold into F20-1
- On the ghost mount the fresh DB showed "0 agent profiles · + operator" on home; on the healthy
  mount the same seed produced "Agent resources · 3". The seed path evidently part-failed
  silently on the broken mount. Same root cause family as F20-1 (data-root writes failing
  silently), recorded so the fix covers seeding too.

## F20-4 — Codex model/account mismatch fails generic; provider's words stay buried · OPEN
- Seeded Developer ships `model: gpt-5.6-sol`. This deployment's Codex auth is a ChatGPT
  account whose API rejects it: 400 `invalid_request_error` — "The 'gpt-5.6-sol' model is not
  supported when using Codex with a ChatGPT account." (CLI default `gpt-5.6-terra` works.)
- The blocked packet's SIGNAL line says only: "Codex run failed: Codex execution failed.
  Review its authentication and runtime configuration." — double-generic, while the run log
  (`/data/runtimes/codex/run_*.jsonl`) holds the provider's exact sentence. The R19-13 rule
  (surface the tool's own words, redacted) should extend to the Codex/Claude spawn error pipe.
- Second half: the model select offers Sol to a deployment that cannot run it. Options:
  probe-at-save (like MCP "Add & test"), or catch the 400 at run time and mark the model
  unavailable on the catalog with the provider sentence. ASK owner which.
- Live repro: VIB-1 first Developer run, 2026-08-14 13:00:32 (run_u0AEhzY8jybi).

## F20-5 — "…and unblock" recovery option HOLDS; packet accepts repeat confirms · OPEN (UX/coherence)
- On the "Operator run failed" packet, the option "Update the policy / credential and unblock"
  records: "Decision: hold on policy. VIB-1 stays blocked until the project credential policy
  is updated." Label says UNBLOCK, recorded effect is a HOLD; the packet stays open.
- The open packet accepted "Confirm decision" three times → three identical decision entries
  on the canonical timeline (14:36/14:04/14:08 local). A confirmed packet should either
  resolve or refuse the next confirm; silent duplicates corrupt the decision record.
- A human-initiated "Run operator" while the packet stayed open completed 6 turns / $0.27 and
  could take no action (only get_task; coordination paused by the open packet). The UI offered
  the run anyway. Expected: task page says "resolve the open packet first" (or the operator
  short-circuits) instead of a paid no-op.
- Also: this recovery option deep-navigates to project settings on confirm, silently leaving
  the task page — surprising; consider opening settings in context or linking instead.
- ASK owner: intended semantics of that option (hold vs unblock+requeue)?

## F20-6 — Empty task branch + unflagged no-change completion strands acceptance · OPEN
- VIB-2 (verification-only): workspace branch `vib-2` was created at execution start and stayed
  IDENTICAL to main (verified: HEAD=f149171=main, no diff, never pushed). The UX Verifier's
  completion said "no repository changes" but its envelope did not set `noChanges`, so
  `accept_completion` refused with "[noop] VIB-2 has delivered work but no review pull request —
  deliver the branch & open the PR before accepting" — advice that would open an EMPTY PR.
- The fail-closed accept-time re-verification (no-change basis: no_repo/no_branch/branch_empty)
  only runs when the completion CLAIMS noChanges. When the flag is missing but the branch is
  actually empty, the server neither detects branch_empty nor says so; the operator had to open
  a decision packet (it did, excellently) and the human must pick "discard the branch".
- Fix directions (owner to pick): (a) accept_completion detects branch_empty and routes to the
  no-change path (still disclosing); (b) refusal message at least states the branch is empty
  and suggests the discard; (c) completion pipeline infers noChanges when diff-empty at report
  time. Live repro: VIB-2, 2026-08-14 ~16:0x. Operator packet quality here was excellent.
- **Compounding (live-proven)**: the packet's operator-pick "Delete vib-2 branch, complete task
  with no changes" is UNEXECUTABLE — the operator has no branch-discard tool (repo writes are
  human-authority), confirming the option performs nothing server-side, and the task page has
  no human control to delete a task branch short of archive_task(+deleteBranch). The human's
  chosen recovery could not be carried out by anyone in-app; I had to `git branch -D` in the
  workspace by hand. The fix must give SOMEONE an executable discard: either confirm-executes
  (server deletes the never-pushed local branch on the human's confirm) or a task-page control.

## F20-10 — A declared org MCP server that fails to start contributes zero tools to a run while every surface says "mounted / healthy" · OPEN — MED
- **Batch-1 lane E / UC-13 (lane-local "F20-7"); verifier CONFIRMED via run logs + DB.** Live
  2026-08-14 19:33Z, VIB-6 Developer/Codex: registry row `everything` = `up:1, tools_count:16`,
  `last_checked_at` 7h stale; run_inputs = `mcp:{mounted:[everything,web-fetch,viberr_browser],
  unresolved:[], unhealthy:[web-fetch]}` and the run-inputs line rendered "3 MCP servers · 1 grant
  did NOT reach this run" naming only web-fetch. But the codex session's `ALL_TOOLS` held only
  `viberr_browser` + builtins and `tools.mcp__everything__echo is not a function`.
- Root cause under the app: the stdio server `npx -y @modelcontextprotocol/server-everything`
  crashed at spawn — its npx tree was half-installed (empty `_npx/…/node_modules/ajv/` created
  DURING the run) so every spawn died in <1s with `Cannot find module 'ajv'`. **Nothing surfaced
  it:** no timeline event, no run-panel warning, and the registry row never changed (health is only
  learned from an explicit Add/Retest, never from a run — the row still read `up:1/16 tools` after
  both the failed AND the successful mount). The agent had to discover the gap itself and block
  with a question.
- Expected: a mount-time failure should join the existing `unresolved` disclosure (which already
  supports mounted-but-down), flip/flag the registry row, and leave a trace on the run. Closely
  related to N20-2 — package-manager MCP servers should be WARMED before a run, not installed
  inside it (the same cold-install race that N20-2 caught at registration shows up silently at run
  time here). The lane hand-repaired the corrupt npx tree to let UC-11/12/13 complete; that repair
  is the concrete trigger, not a product change. Evidence: `screenshots/uc/UC-13-01..04`,
  container run logs `run_7kuw3_TK8Aru.jsonl` / `run_w9kfY0StPzZ9.jsonl` / `run_mqBN7wAh5i5p.jsonl`.

## F20-11 — Task-page notification auto-read fires on background revalidation, so a parked tab silently eats notifications and the bell never badges · OPEN — MED · ASK
- **Batch-1 lane D / UC-23 (lane-local "F20-N1", the lane's headline); verifier CONFIRMED to the
  millisecond.** The R19-15 "view marks seen" contract is implemented in the task loader
  (`app/routes/project.task.tsx:120-131` calls `markTaskNotificationsSeen`), justified in-comment by
  "the app uses no link prefetch (this loader runs only on a real view)". But every SSE-driven
  revalidation re-runs that loader as a `.data` GET, and single-fetch POST navigations run it in the
  action's own request — so a task left open in a background tab consumes any notification that
  arrives on that task within ~13–440 ms, and the bell badge never rises.
- Live proof across the day's 21 rows: 19/19 of arda's notifications were read 13–440 ms after
  creation and NO successful mark-read POST exists in the container log (the only two
  `/notifications/read` requests in the entire history are the lane's own probes). The bell showed 0
  through 19 notifications INCLUDING four "Blocked — decision needed" packets. Contrast the clean
  case: the same VIB-5 packet for arda with no arda tab parked stayed unread 115 s and was consumed
  by the first real page view.
- **ASK owner** (fix directions): mark only on a genuine document/navigation load (not `.data`
  revalidations), and/or gate on document visibility; keep the existing monotonic/idempotent
  contract. Evidence: `screenshots/uc/UC-23-03-bell-before.png`, `UC-23-04-bell-after-vib2-view.png`,
  `scratchpad/uc23-unread.log` (12 `unread=1` samples).

## F20-12 — Project Members-card invite of an unknown email mints a passwordless account that can never sign in, and the UI reports it as healthy · OPEN — MED
- **Batch-1 lane B / UC-16 (lane-local "F20-A"); verifier CONFIRMED via audit_events.** As an org
  admin on `/projects/<slug>/settings → Members → Invite`, inviting an email the instance does not
  know (e.g. `probe.nobody@viberr.dev`) toasts "Invite sent … joins as Viewer" and grows the member
  list — but `inviteMember` (`app/features/project-settings/settings-actions.server.ts:604-652`)
  calls `createUser(…, { tempPassword: null })`, and `createUser`
  (`app/server/auth/user-admin.server.ts:76-106`) then sets `passwordHash = null`,
  `pwresetRequired = false`, `passwordless = true`. Because `statusOf`
  (`app/server/org/org-users.server.ts:83-89`) returns "invited" (the "setup pending" pill) only
  when `pwresetRequired && !lastLoginAt`, the row renders with NO pill — indistinguishable from a
  working account.
- The invitee then hits a flat contradiction at `/login` ("No local account for that email — ask an
  admin to create one, or sign in with GitHub / Google if you're whitelisted", on a deployment whose
  own login page says SSO isn't configured), and re-adding the same email via Allow-access is refused
  "A user … already exists." The only undocumented exit is Users & access → Edit → Reset password.
- Fix directions: give the invite path the same temp-password ceremony as Allow-access (or refuse
  the create and point at it), and make `statusOf` surface a passwordless local account as
  not-yet-usable rather than "active". Evidence: `screenshots/uc/UC-16-10`, `-16`, `-17`, `-18`.
  Residue: the specimen account `probe.nobody@viberr.dev` still exists (removed from the project,
  account never deleted).

## F20-13 — An add→move→remove stage round trip permanently TIGHTENS a workflow boundary with no disclosure · OPEN — MED
- **Batch-1 lane C / UC-28; verifier surface confirmed.** In Probe Sandbox, `ready → impl` started
  as `boundary: auto` / by "Operator, when a delivering agent is assigned"; after adding stage
  "Hold", renaming/moving it, then removing it, the same hop persisted as `boundary: human` / by
  "Human decision" and the Policy page showed "Human only" selected on Ready → In Progress.
- Cause is deliberate per-rule (`rejoinChainAroundStage` takes the stricter of the two edges,
  `app/shared/workflow/transitions.ts:160-215`; `realignChainToStages` inherits the target's entry
  gate) but the COMPOSITE result is undisclosed: the toast says only 'Stage "Parked" removed' and the
  audit row says only "Arda removed a workflow stage." — no mention that Ready → In Progress stopped
  auto-advancing. The product already has the vocabulary (a manual flip audits as "Arda set ready →
  impl to auto-advance."). Fix direction: disclose the boundary change in the toast + audit row when a
  structural edit retightens a hop. Confirm with owner that stricter-of-two is the intended
  semantics. Evidence: `screenshots/uc/UC-28-01`, `-04`, `-12-policy-after-roundtrip-TIGHTENED.png`.

## F20-14 — Project creation never verifies the repository, while Repair does · OPEN — MED
- **Batch-1 lane C / UC-30; verifier confirmed the asymmetry.** Creating a project with repo
  `hello-world-DOES-NOT-EXIST` succeeds silently — project.md written, board opened, no warning on
  board or Settings — yet `repairProjectRepo`
  (`app/features/project-settings/settings-actions.server.ts:299-330`) probes `GET /repos/{repo}`
  with the bound credential and refuses a 404 with precise copy. The same probe is simply absent at
  the moment a typo actually happens (project-create path). Fix direction: run the Repair probe at
  create time. Evidence: `screenshots/uc/UC-30-04`, `-05`, `-07`, `-08`.

## F20-15 — The repair probe accepts a repo the credential can only READ (never checks push) · OPEN — MED
- **Batch-1 lane C / UC-30; verifier confirmed live.** `repairProjectRepo` only checks `res.ok` on
  `GET /repos/{repo}`; it never inspects `permissions.push`, even though
  `app/server/secrets/pat-validator.server.ts:232-240` already computes `repoWritable(permissions)`.
  Live: repairing Probe NotFound to the foreign public repo `octocat/Hello-World` SUCCEEDED and
  adopted octocat's default branch `master`, so a project can be pointed at a repo it can never push
  a branch to or open a PR on — the failure surfaces only at first delivery. Dialog copy is accurate
  to what it checks, but the project's whole purpose is writing. Fix direction: gate the repair (and
  the F20-14 create probe) on `repoWritable`. Evidence: `screenshots/uc/UC-30-09-repair-public-octocat.png`.

## F20-16 — Four read-only deny notes tell a maintainer they hold an admin-only grant, and cite an invented grant name · OPEN — MED
- **Batch-1 lane B / UC-17 (lane-local "F20-B"), live-proven at Maintainer; verifier confirmed the
  rbac constants.** With Deniz set to Maintainer, `/projects/<slug>/settings` still rendered every
  card read-only under "Read-only — editing project settings needs the **Change project settings**
  grant (project admin or maintainer)." (`settings-page.tsx:114`, same at `:791` and `:1178`) — all
  three gate on `canEditPolicy = roleCan(myRole,"edit-policy")` (`:1483`), and `edit-policy` is
  `roles: [A]` (`rbac.ts:81`). `/projects/<slug>/agents` repeats it (`agents-page.tsx:1260`, gated on
  `manage-agents` = `[A]`, `rbac.ts:80`). So a maintainer is told they hold a grant the page then
  refuses.
- Second half: the cited grant NAME does not exist in the Policy matrix — the human row is "Edit
  workflow & policy", while "Change project settings" collides with the AGENT capability
  `change-project-policy` "Change project policy" (`capabilities.ts:136`). The Policy page itself
  gets both right (`policy-page.tsx:457`), and `github-view.tsx:165` is correct
  (`grant-github-scope` is `[A,M]`), so the surfaces disagree. Fix direction: correct the four deny
  notes to name the real grant ("Edit workflow & policy") and the real tier (project admin).
  Evidence: `screenshots/uc/UC-17-31-…-copy-contradiction.png`, `-32-…`.

## F20-17 — A role that cannot resolve a decision packet at all is still shown the interactive option radiogroup, with no Confirm and no reason · OPEN — MED
- **Batch-1 lane B / UC-17 (lane-local "F20-C"); verifier confirmed the code path.** `DecisionPacket`
  computes per-option blocks only for two kinds — `goalBlocked = kind==="edit_goal" && !canEditGoal`
  and `archiveBlocked = kind==="archive_task" && !canArchive` (`decision-packet.tsx:450-456`) — and
  consults `canResolve` (= `canRunAgents || isOwner`, `task-detail-page.tsx:251`) ONLY to hide the
  note field, the block reason and the Confirm button (`:519-565`). So an option of any other kind
  stays fully interactive for someone who can never confirm it, and the card never says "your role
  can't resolve this". Live: Deniz (Contributor, non-owner) selected an un-gated option (radio
  filled) with no Confirm ever rendered, while the two gated options carried "· your role can't
  archive — a maintainer must" — i.e. the un-noted option reads as the one that IS theirs. Fix
  direction: when `!canResolve`, mark every option `aria-disabled` and render one card-level deny
  note naming who can decide. Evidence: `screenshots/uc/UC-17-12`, `-40-deniz-NONOWNER-packet-no-confirm.png`.

## F20-18 — A contributor-owner can be handed a packet in which EVERY option is forbidden to them, with no in-app way to clear their own task · OPEN — MED
- **Batch-1 lane B / UC-17 (lane-local "F20-D"); verifier confirmed via task files.** On VIB-5
  (created by Deniz as Contributor, owned by Deniz) the operator's packet offered exactly two options
  — `archive_task` and `edit_goal` — both role-blocked for a contributor, so the owner-exception
  `canResolve` rendered a live-looking "Confirm decision" whose only companion line was "Archiving is
  reserved for maintainers and admins." The owner could resolve nothing; the deny notes name a role
  but no next step, and nothing routes/notifies a maintainer. Related asymmetry: `create-task` is
  `[A,M,C]` but the only disposal, archive, is maintainer+ (`approve-transition`,
  `project.task.tsx:528-537`), and the Archive control simply vanishes on a contributor's own task
  with no note — a contributor can create board clutter they have no in-app way to clear (both VIB-4
  and VIB-5 had to be archived by an admin). Fix direction: either give a contributor-owner a real
  disposal path, or route/notify a maintainer when every packet option is above the owner's tier.
  Evidence: `screenshots/uc/UC-17-35-deniz-owns-vib5-no-archive.png`, `-37`.

## F20-19 — The Policy page never states the project's configured operator autonomy, so a reader cannot tell whether the human-only-Done exception is live · OPEN — MED
- **Batch-1 lane C / UC-19; verifier confirmed byte-identical rendering.** With Probe Sandbox's
  operator at Full autonomy (with `completion-for-acceptance: direct` already granted — the exact
  combination that lets an operator close tasks itself, `operator-actions.server.ts:2580`), the Policy
  page was byte-for-byte identical to the supervised state: same counts, same "ALWAYS RESERVED FOR
  HUMANS · Transition a task to Done · except an operator at full autonomy…" conditional prose. The
  configured autonomy value appears only on the Agents profile card, buried under "Context resources
  & runtime". Fix direction: state the project's configured operator autonomy on the Policy page so
  the conditional exception can be read as live or not. Evidence:
  `screenshots/uc/UC-19-05-policy-full-autonomy.png`.

## F20-20 — Granting full operator autonomy is audited as a generic profile update · OPEN — MED
- **Batch-1 lane C / UC-19; verifier confirmed the audit shape.** The Policy page calls the
  human-only-Done exception "an explicit, audited opt-in", but saving full autonomy records
  `project.agent_profile.updated` with `details: { name, role, backend }` only
  (`app/features/agents/agent-profile-actions.server.ts:578-595`) — autonomy is not in the details,
  and the renderer prints the generic "Arda updated agent profile Operator." A grant and its
  revocation are two identical rows, indistinguishable from a persona typo fix; the toast is likewise
  generic. The pattern for calling out a consequential grant already exists in the same call
  (deliveryGrants/deliveryNote details). Fix direction: record the autonomy change (and the
  direct-accept grant) explicitly in the audit details + toast.

## F20-21 — Specialist `recommend` grants are silently coerced to `direct` everywhere; the canonical project.md disagrees with every rendered surface · OPEN — MED · ASK
- **Batch-1 lane C / UC-19; verifier confirmed the seed vs render mismatch.** `coerceSpecialistCapabilityMode`
  (`app/shared/capabilities.ts:316-318`) maps `recommend → direct` for specialists and the enforcement
  layer agrees (`isWithheld` only blocks human/off), yet the seeded canonical project.md ships
  `move-task-to-review: recommend` for Developer and `approve-review`/`request-changes: recommend` for
  Reviewer (matching `agent-catalog.server.ts:135`, `:158`). Result: the matrix shows "Move the task
  to Review — Acts directly" and "Approve the review — Acts directly", and the Policy counts read
  "Developer · 8 direct · 0 recommend" and "Reviewer · 10 direct · 0 recommend" for a file that
  literally says 7 direct + 1 recommend and 8 direct + 2 recommend. The operator's own `recommend`
  renders correctly, so the two agent kinds read the same file differently — and widening
  (recommend→direct) is the dangerous direction. **ASK owner:** should the seed stop writing
  `recommend` for specialists, or should the file-read normalize AND disclose? Evidence:
  `screenshots/uc/UC-19-02-matrix-recommend-as-direct.png`.

---

# LOW / nit

## F20-2 — Boot leaves defunct chromium zombies under pid 1 · OPEN (hygiene)
- `ps -ef` in the container showed 8 `<defunct>` chromium/chrome_crashpad processes parented to
  pid 1 (node), created at boot (~10:30). Something probes chromium at boot (browser capability
  or MCP probe) and never reaps children. Node-as-pid-1 has no init to reap orphans.
- Fix directions: reap children (SIGCHLD handler / detached+unref+wait), or run the container
  with `init: true` in compose. Small, but a long-running deployment accumulates zombies per boot.
  Fix spec: §5b.

## F20-22 — A stdio MCP command that dies without printing drops its exit code/signal · OPEN (honesty)
- **Batch-1 lane A / UC-14 (lane-local "F20-8"); verifier confirmed the code.** Editing an MCP
  command to `node -e "process.exit(3)"` and re-testing yields the toast "…did not answer — exited
  before responding" and `last_error` = the bare "exited before responding"; exit status 3 is
  dropped. Source: `app/server/org/resources.server.ts:930-933`
  `child.on("exit", () => finish({ kind: "down", reason: withDetail("exited before responding") }))`
  ignores the `(code, signal)` arguments Node passes. Same R19-17 spirit as the stderr work: "exited
  before responding — exit code 3" (or "killed by SIGSEGV") is free information already in hand. Fix
  direction: fold `(code, signal)` into the reason. Evidence: `screenshots/uc/UC-14-5-silent-exit-no-code.png`.

## F20-23 — The GitHub Execution-branches table never shows "closed" for a closed-not-merged PR · OPEN (honesty-completeness)
- **Batch-1 lane F / UC-02 (lane-local "F20-7"); verifier confirmed via live DOM.** With VIB-8 at
  Review and PR #162 closed on GitHub, `/projects/<slug>/github → Update status`: the **Pull
  requests** list correctly renders "#162 … closed", but the **Execution branches** row for VIB-8
  renders only `<span class="pill risk sm">#162</span>` — a bare number with a red-ish tint and no
  state word — while merged rows render an explicit `pill done sm::merged`. A reader scanning that
  table cannot tell the delivery was rejected. Fix direction: render a state word ("closed") on the
  branch-row pill. Evidence: `screenshots/uc/UC-02-06-github-page-pr162-closed.png`.

## F20-24 — "Archive task and delete branch (discard work)" deletes only the remote ref; the local commit survives and one click re-pushes it · OPEN (label-vs-effect)
- **Batch-1 lane F / UC-02 (lane-local "F20-8"); verifier confirmed.** The recovery option says it is
  "discarding the rejected probe work entirely", but it only deletes the **remote** ref; the commit
  survives in the task workspace (`git branch -vv` still shows `* vib-8 447fb18` after the "discard
  work" archive) and the app will happily re-push it: "Restore from archive" re-surfaces the GitHub
  panel with an **enabled** "Deliver branch & open PR" that would push the 'discarded' work back and
  open a fresh PR. The confirm dialog is more careful ("the remote branch … and every commit that
  exists only there"), so this is the option SUMMARY overstating, plus an undisclosed one-click
  un-discard. Fix direction: either delete the local branch too, or narrow the summary to "delete the
  remote branch" and disclose that restore can re-deliver. Evidence:
  `screenshots/uc/UC-02-17-restored-task-branch-still-offered.png`.

## F20-25 — Restoring a task whose packet was withdrawn by the archive strands it on "Waiting on: Human decision" · OPEN (coherence)
- **Batch-1 lane F / UC-02 (lane-local "F20-9"); verifier confirmed.** After archive+delete, "Restore
  from archive" leaves the task claiming Stage = Review / **Waiting on = Human decision** with no
  "Decision required" section, no pending recommendation and no queued operator run — contradicting
  the archive dialog's own promise ("WITHDRAWN … restoring the task reopens the question"). The only
  guidance is the acceptance-blocked sentence; the human must know to press "Run operator". Also the
  restored task's Execution-branches SYNC cell reads the opaque "not compared" for a branch whose
  remote ref no longer exists — honest but no surface outside the timeline ever states "branch deleted
  on remote". Fix direction: on restore, either re-open the withdrawn question or clear the
  Waiting-on-Human state. Evidence: `screenshots/uc/UC-02-16`, `-17`.

## F20-26 — Changing a transition boundary leaves the human-readable `by` prose stale, producing a self-contradicting Policy row · OPEN
- **Batch-1 lane C / UC-28; verifier surface confirmed.** `setTransitionBoundary`
  (`app/features/policy/policy-actions.server.ts:199-217`) mutates only `rule.boundary`, never
  `rule.by`, even though `defaultTransitionBy` exists (`app/shared/workflow/transitions.ts:55-65`).
  Live and persisted: Triage → Ready flipped from "Human only" to "Human approval" and the row still
  read "Human decision" (correct copy for `human`, wrong for `approval`); Ready → In Progress renders
  "Human decision" with Auto-advance checked (disk shows `boundary: auto, by: Human decision`). Fix
  direction: recompute `rule.by` via `defaultTransitionBy` on every boundary change. Evidence:
  `screenshots/uc/UC-28-15-stale-by-prose.png`, `-16`.

## F20-27 — Stage add/remove audit rows drop the stage name (writer/renderer mismatch) · OPEN
- **Batch-1 lane C / UC-28; verifier surface confirmed.** `project.stage.added` records `details: {}`
  (`settings-actions.server.ts:447-453`) while the renderer reads `d.name`
  (`activity-feed.server.ts:200-205`), so it always prints "Arda added a workflow stage.";
  `project.stage.removed` DOES record `details: { name }` (`settings-actions.server.ts:526-533`) but
  the renderer ignores it (`activity-feed.server.ts:212`) and prints "Arda removed a workflow stage."
  Only the rename names its stage. Fix direction: write the name on `added` and read it on `removed`.
  Evidence: `screenshots/uc/UC-28-13-audit-log.png`, `-17`.

## F20-28 — ⌘K does not rank an exact task-key match first · OPEN (search)
- **Batch-1 lane D / UC-24 (lane-local "F20-S1"); verifier REPRODUCED LIVE.** ⌘K → "VIB-1" lists VIB-2
  ("Browser-verify the merged VIB-1 marker on GitHub") as row 0 (`data-active=true`) and VIB-1 second,
  because `app/features/shell/command-search.server.ts:111` ranks the single LIKE scan by
  `ORDER BY updated_at DESC` only, with no exact-key/prefix boost. Type a full task key + Enter →
  land on a DIFFERENT task. Fix direction: add an exact-key/prefix rank boost. Evidence:
  `screenshots/uc/UC-24-01-palette-vib1.png`. (An earlier lane's `UC-24-04-exact-key-misranked.png`
  is the same defect — already de-duplicated here.)

## F20-29 — ⌘K leaves archived projects unlabelled while archived tasks are labelled · OPEN (search)
- **Batch-1 lane D / UC-24 (lane-local "F20-S2"); verifier REPRODUCED LIVE.** Query "probe" returns
  "Probe NotFound · octocat/Hello-World" as the first hit with no marker, although its project.md has
  `archived: true` and the Home grid files it under "Archived". Tasks get `archivedSub()` ("Viberr ·
  archived", F19-8), but `projectHits` in `command-search.server.ts` sets `sub: p.repo ?? p.slug` and
  drops the flag it already has (`HomeProject.archived`, `home-query.server.ts:61`, `:234`). Following
  the hit lands on the archived board with the honest banner, so the damage is confined to the palette
  row. Fix direction: label archived project hits like archived task hits. Evidence:
  `screenshots/uc/UC-24-06`, `-07`.

## F20-30 — ⌘K is not registered app-wide (absent on /profile, /notifications, /org/settings) · OPEN (shell consistency)
- **Batch-1 lane D / UC-24 (lane-local "F20-S3"); verifier confirmed structurally.** `home-page.tsx:85`
  states "⌘K is ONE shortcut app-wide", but `useCommandPalette` is imported by only two non-test files
  (`app/features/home/home-page.tsx`, `app/features/shell/topbar.tsx`), and `app/routes.ts` registers
  `profile`, `notifications` and `org/settings` as top-level routes outside the workspace layout — so
  those three routes have neither the shortcut nor any search affordance; the user must navigate back
  first. Fix direction: register the palette at a layout that covers those routes (or correct the
  copy).

---

## Nits / notes

- **N20-1**: login email input is `type="text"` (deliberate? no browser email validation; fine for
  a mono style but loses mobile email keyboard). Low priority. (Main-session nit.)

- **N20-2 — Cold npx MCP registration says "timed out after 20s", no warm-up · ruled R20-4.**
  `npx -y @modelcontextprotocol/server-everything` on a cold npm cache exceeded the 20s probe;
  row showed `unreachable · timed out after 20s` with no stderr excerpt and NO R19-18 warm-up
  (npx's progress output evidently didn't match the visibly-installing heuristic). A manual
  retest immediately succeeded (16 tools) because npm had cached the package meanwhile. uvx path
  is fine: `uvx mcp-server-fetch` correctly showed "installing on first use — finishing in the
  background" and self-resolved. Resolved by R20-4 (Spec 4). Directly related to F20-10 — the same
  cold-install race surfacing SILENTLY at run time.

- **N20-3** — (reserved). No finding was recorded under this id in the source material handed to
  this consolidation; kept as a placeholder so the sequence is not misread as a gap and new ids
  start at N20-5.

- **N20-4 — The PR body's "Viberr task" link is relative · OPEN.** Main-session finding, specified
  in FIX-SPECS §5a. `composePrBody` (`app/server/github/pr-open.server.ts:42`) builds the task URL
  (`:82-91`) and falls back to a RELATIVE `/projects/…` path when both `appOrigin` and
  `BETTER_AUTH_URL` are unset — a link that 404s on github.com. Fix (per §5a): add an `appOrigin()`
  reader to `env.server.ts`; when it is null, OMIT the link and write the plain store-relative key.

- **N20-5 — MCP name refusal quotes the slugified name the admin never typed.** Batch-1 lane A /
  UC-09b (lane-local "N20-5"); verifier confirmed. The Add-MCP modal slugifies before saving
  (`app/features/org-settings/resource-modals.tsx:137` sends `name: slugify(name)`, and `slugify`
  maps `_` → `-`), so typing `viberr_browser` yields the refusal '"viberr-browser" is reserved…' and
  typing "My Server" would silently create `my-server`. Nothing in the field or hint says the name
  is rewritten. Cheap fix: show the slug under the field ("will be saved as viberr-browser").
  Evidence: `screenshots/uc/UC-09b-2-refusal-underscore.png`.

- **N20-6 — "Invite sent to <email>" claims an email was sent though there is no mailer.** Batch-1
  lane B / UC-16 (lane-local "N20-A"); verifier confirmed. The project-invite toast
  (`settings-actions.server.ts:652`) says "Invite sent to <email> · joins as Viewer"; there is no
  mailer (the code comment says "no mailer in V1, ruling 13") and two other surfaces state the
  opposite in the same session ("no invite emails, access on first login"). Suggest "Added <email>
  to Viberr · joins as Viewer".

- **N20-7 — The owner exception is documented for acceptance but not for packet resolution.** Batch-1
  lane B / UC-17 (lane-local "N20-B"); verifier confirmed the server path. The Policy footnote and
  the task Permissions rail document that a contributor who OWNS a task may accept its completion,
  but neither mentions that an owner may also resolve non-acceptance packet options
  (`task-actions.server.ts:4505-4519`: `else if (isOwner) { /* owner is allowed */ }`). A
  contributor-owner therefore holds an authority no surface tells them about.

- **N20-8 — Sibling deny notes phrase the same [A,M] tier two different ways.** Batch-1 lane B /
  UC-17 (lane-local "N20-C"). On the same card: "Editing the goal is reserved for maintainers." vs
  "Archiving is reserved for maintainers and admins." (`decision-packet.tsx:383-385`) — both actions
  are `[A,M]`; the first reads as excluding admins. Pick one phrasing.

- **N20-9 — The boundary audit row prints raw stage ids instead of names.** Batch-1 lane C / UC-28.
  "Arda set ready → impl to auto-advance." while the stages display as "Ready" and "In Progress"
  (`details` store `input.from`/`input.to` verbatim, `policy-actions.server.ts:230-237`); the toast
  for the same action correctly uses resolved names. Resolve the ids to names in the audit detail.

- **N20-10 — New stages persist a CSS token (`var(--yellow-dark)`) into the canonical project.md.**
  Batch-1 lane C / UC-28. `NEW_STAGE_COLORS` (`settings-actions.server.ts:63-68`) writes
  `color: var(--yellow-dark)` into the canonical project file while every seeded stage stores a hex
  value. project.md is the human-readable governance record and is read by agents; a stylesheet
  variable there is meaningless outside the browser. Store a hex (or a semantic token the file layer
  understands).

- **N20-11 — The new-project repo field silently mangles an owner-qualified entry.** Batch-1 lane C /
  UC-30. The repo field has a hard-coded `akin-ozer/` prefix and a one-segment input;
  `octocat/Hello-World` becomes `octocathello-world` (a plausible-looking but wrong repo under the
  fixed owner) with no message that the owner is fixed by the connection. Say so under the field.

- **N20-12 — The profile Email hint promises an admin edit it neither offers nor links.** Batch-1
  lane D / UC-23 (lane-local "F20-P1"); verifier confirmed. `/profile` renders
  `<input id="profile-email" … disabled>` with the hint "local account · admins can edit"
  (`app/features/profile/profile-page.tsx:164-166`). The viewer here IS an org admin and the real
  editor exists at Org settings → Users & access → Edit, but the page links its other destinations as
  chips while omitting this one. Either link the destination or say where.

- **N20-13 — The PageOverlay close button floats over scrolled right-column content.** Batch-1 lane
  D / UC-23 (lane-local "F20-P2"); cosmetic. At 1440×900 on `/profile` scrolled to the bottom,
  `.overlay-x` (position:absolute, z-index 5) overlaps the "Manage agent profiles" access row and
  clips ~8px of its status icon. Only a non-interactive icon is affected here, but any long
  right-column content passes under the button. Evidence: `screenshots/uc/UC-23-06-profile-lower.png`.
  (Pixel rects were not re-measured by the verifier.)

- **N20-14 — The force-accept "awaiting verdict" validation chip survives the bypass · ⇄
  PRD-ALIGNMENT C2.** Main-session UC-04 nit, specified in FIX-SPECS §5c, and the same predicate
  PRD-ALIGNMENT **C2** generalises. Force-accept records only an audit row
  (`task-actions.server.ts:5808-5817`), so no frontmatter/projection field carries the fact and
  `deriveValidation` recomputes validation straight back to `"changed"` = "awaiting verdict"
  (`app/ui/pill.tsx:96`, `app/schemas/task-file.schema.ts:579-617`) — a force-accepted, Done task
  reads `accepted · awaiting verdict` on the hero and its card. Fix (per §5c): a durable `acceptance:
  "forced"` frontmatter fact with a `bypassed` validation display.

---

## Verified non-findings (looked wrong, confirmed correct — do NOT "fix")
- **Egress/browser interlock is disclosed, not silently mounted** (batch-1 lane E / UC-08). With
  use-browser Allowed but use-web-search-fetch Off, the run mounted zero browser tools and
  `unresolvedResources` carried the exact contradictory-pair sentence (P14-LV-09). Correct.
- **Codex loads every granted skill as full prompt text; only Claude gets file-mounted, on-demand
  skills** (batch-1 lane E / UC-11, lane-local "N20-5"). The behavioural canary passed (AMBER-FALCON-7
  cited, decoy CRIMSON-YAK-99 never surfaced); the structural asymmetry is the DISCLOSED, sanctioned
  divergence of ruling 51 / R18-5 (PRD-ALIGNMENT List 1 #19), and the run-inputs panel is honest about
  it. Not a defect — a token-cost note at most.
- **Clicking the page's "Confirm decision" behind an open disclosure MODAL does nothing** (batch-1
  lane C / UC-19 process note). The page behind the modal is inert; the real control is inside the
  dialog ("Archive PS-1"). This is distinct from F20-5's genuine repeat-confirm bug (which was on an
  OPEN packet with no modal). Not a dead button.
- **⌘K LIKE-wildcard escaping** (`%`, `_`, `\`, `'`, `VIB_1` → 200 / 0 hits, no SQL error) and the
  **CSRF-failure `{ok:false,error}` JSON at 403** both behave correctly (batch-1 lane D). F19-16 agent
  deep-link, F19-8 archived-TASK labelling, and the notifications overlay `returnTo` all hold.
- **UC-08-04 "assign 400 silent"** (batch-1 lane E) was NOT reported: `useActionFeedback`
  (`task-detail-hooks.ts:28-47`) pushes an error toast for failed fetchers, so a toast most likely
  showed and faded before the screenshot. Left out rather than filed on a guess — worth a dedicated
  retest by whoever owns the assign/engage surface.
- **A closed PR briefly showing "2/2 checks running"** that self-corrected on the next poll (batch-1
  lane F) is a cosmetic transient, not filed.

## Evidence-integrity notes (carry into implementation)
- The DB half of **F20-7** (plaintext `last_error` sitting beside `cred_ref`) is no longer
  re-verifiable — the probe row was deleted at 17:30:08Z — so F20-7 rests on the A/B screenshot pair
  plus the confirmed code path (both verified).
- **F20-8** boot-refusal count is NINE (verifier correction to the lane's "eight"); the EPIPE 5/40
  rate and its causal link to the actual death remain a labelled CANDIDATE, not a proven cause (the
  verifier did not re-run the probe scripts).
- Several screenshots are byte-identical pairs: `UC-16-09`/`UC-16-19` (so the forced-set-password
  shot cannot attribute the event to `probe.nobody` — the DB timestamps do), `UC-14-2`/`UC-14-3`
  (the "after reload" shot is not independent proof of a reload), `UC-23-02-inbox-unread-empty`/
  `-filter`, `UC-08-05`/`UC-08-05b`. `scratchpad/uc23-catch.log` is a 38-byte stub (cited but
  resultless).
- Live residue: the org account `probe.nobody@viberr.dev` still exists (project membership removed,
  account never deleted) — it is the live specimen for F20-12.

---

# Batch-2 findings (live campaign, 2026-08-15) — verifier CONFIRMED all, nothing refuted

Batch 2 exercised the OLD container image (b97ad02), so several observations are
things my in-flight fixes already address (recorded as corroboration); the rest are NEW.

## Corroborated (already being fixed)
- **D1 / F20-9 confirmed live** (UC-18): a SUPERVISED operator's Agents card + matrix render
  "Accept completion into Done · Acts directly" that the runtime refuses; sits beside
  "Transition a task to Done · Reserved for humans" with no reconciling note. Fix = R20-7 (C-AGENTS).
  UC-18 also PROVED the good half: promotable:false held (Supervised→Full did NOT auto-promote the
  grant), all ALWAYS_HUMAN locks render locked in every editor surface.
- **F20-23 corroborated** (UC-25, both backends): closed PR shows a "closed" pill on /github after
  Update status — but the Execution-branches TABLE still doesn't say closed (the F20-23 gap stands).
- **N20-4 corroborated** (UC-25): PR #165/#166 bodies carry the relative `/projects/...` link (404s on github.com).
- **UC-05 update-branch PASS, UC-29 rescan/rebuild PASS, UC-10 attachment governance PASS,
  UC-21 mention→reply→auto-read PASS, UC-20 secondary-engagement coexistence + verdict-binding
  (code) confirmed.** UC-07 codex-browser + UC-20 live verdict were BLOCKED by a transient
  container egress outage (environmental, not a defect).

## F20-31 — Operator front-runs a clarifying question the goal DELEGATED to the delivering agent · OPEN — MED · ASK
- UC-22 (VIB-9). Goal said "FIRST ask the human owner, via YOUR ask-human capability" (aimed at the
  Developer). At triage the OPERATOR instead opened its OWN input packet (type:input, "Decision
  required", from:operator, no askedBy) to gather the amber/cobalt choice itself — no disclosure it
  was substituting for the delegated developer ask. (I saw the same shape live in VIB-9's amber/cobalt.)
- ASK owner: when a goal explicitly delegates an ask to the delivering agent, should the operator
  hand off to that agent (deploy it, let IT raise the ask_human) rather than gather the answer
  itself? Or is operator-gathers-at-triage the intended coordination? Either way the substitution
  should be DISCLOSED.

## F20-32 — Codex developer FALSELY narrates "ask-human capability is unavailable" while using it · OPEN — MED
- UC-22. On Codex the ask-human channel is the outcome-envelope `question` field (not a callable
  tool; toolkit was []). The developer's envelope both CLAIMED "the available ask-human capability
  is unavailable in this session, so I cannot obtain the required confirmation" AND successfully
  populated `question` to ask it. The persona/prompt must describe the Codex ask-human channel
  accurately so the agent doesn't narrate a false limitation. Fix: persona/toolkit-description text
  for the Codex backend.

## F20-33 — The OPERATOR's Codex fallback model is also gpt-5.6-sol (unrunnable) · OPEN — MED
- UC-26. Switching the operator to Codex and running → hard 400 "gpt-5.6-sol not supported … with a
  ChatGPT account". The operator has no concrete codex model (seed model "orchestration runtime",
  agent-catalog.server.ts:82-83) and falls back to the model-catalog codex DEFAULT gpt-5.6-sol.
  R20-8 fixed only the seeded Developer. Fix: the catalog codex default (and/or the operator's codex
  fallback) → gpt-5.6-terra, so a fresh deployment's operator-on-Codex is runnable. Pairs with R20-3
  (which now surfaces the provider sentence) and R20-8.

## F20-34 — Operator/Codex spawn failure still surfaces generically (extends F20-4/R20-3) · OPEN — verify
- UC-26. The operator-Codex 400 surfaced as the generic "Operator run failed — pick a recovery
  path"; the provider's exact sentence was only in the run log. R20-3 Phase A wired
  `escalateFailedOperatorRun` to carry `reason.text` — VERIFY at live-validation that the operator
  spawn-error path (not just the specialist path) actually surfaces the provider sentence now.

## Batch-2 nits
- **N20-15** — the packet "Ask operator" button appears inert on input/agent-question packets (3
  real clicks → no server write, no run), while "Confirm decision" works. Confirm whether "Ask
  operator" is meant to function on non-failure packets, else disable/hide it there.
- **N20-16** — a developer's OWN ask_human packet ("Agent question" from Implementation) labels its
  recommended option "operator pick", attributing the rec to the operator on a packet the developer
  raised. Mislabel.
- **N20-17** — a Done/terminal task disables the explicit "Run operator" button ("reopen it to run")
  yet an @operator comment still triggers a full operator run+reply. One run-path blocked, another
  open, with no in-UI hint that mentioning will run it. Make the two consistent (or hint).
- **N20-18** — in the default (raw-OFF) run console, a Codex `agent_message` renders as the raw
  structured-output JSON envelope (`{"evidence":null,"summary":"…","verdict":null,"question":null}`)
  with the meaningful `summary` buried and null fields shown verbatim, whereas Claude's `assistant`
  event renders as clean prose. Extract+render the Codex envelope's `summary`/`question` as prose in
  the non-raw console (P19-RC1 parity across backends). Fix area: run-console helpers.

## Owner ruling 2026-08-15 (batch-2)
- **R20-9 (on F20-31)**: the operator MAY gather at triage an answer a goal delegated to the
  delivering agent's ask-human (it's needed before work starts), BUT the packet must DISCLOSE it
  is substituting for the delegated agent ask — the timeline must be honest about the substitution.
