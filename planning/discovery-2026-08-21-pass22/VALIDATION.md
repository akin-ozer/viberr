# Pass 22 — validation ledger (2026-08-21)

Each implemented fix, its code validation (tests + tsc), and its live validation (browser/API on the
rebuilt dev server). Full suite: **265 files / 4158 tests green, tsc clean** after all changes.

| Fix | Code validation | Live validation |
|---|---|---|
| **F22-08** Codex failure msg | +2 unit tests (usage-limit in `turn.failed` → kind:quota + retry date; fatal-event-without-throw path). Reproduced the exact real SDK error shape. | PENDING: trigger a Codex run (quota-blocked) → task.md shows "usage limit… try again Sep 18", not the generic auth/config text. |
| **F22-10** PR body stats | +2 unit tests (live compare wins over stale fm.github; falls back when compare unreachable). | PENDING: deliver on a branch colliding with a stale remote branch → PR body stats == actual diff. (Hard to reproduce post-cleanup; unit test is the faithful repro.) |
| **F22-02** schedule pickers | schema/server/route/UI updated; R22 canary tests (no backend/autonomy select; "resolves deployed profile"). | PENDING: open "Schedule a re-run" → only delay + note, note copy present. |
| **R22** Codex sandbox removed | codex-runtime tests (44), runtime-registry parity updated to the ruled asymmetry, capabilities (execute-code→claude-only). | PENDING: trigger a Codex run → sandbox is workspace-write (via process/logs); capability-matrix modal copy reads advisory-on-Codex. |
| **F22-03** persona honesty | RESOLVED by R22 (reviewers workspace-write → attachments writable); test asserts additionalDirectories set for reviewer. | Covered by R22 live check. |
| **F22-01** run-operator overrides | route no longer reads backend/autonomy; full suite green; unused imports removed. | PENDING: crafted POST with backend=claude on a codex operator → run uses the deployed (codex) backend, not the override. |
| **F22-11** lightbox focus | autoFocus on Close; task-detail suite green. | PENDING: open lightbox → focus on Close (aria-label), not "Open original". |
| **Canon** rulings/amendments | (subagent) decisions.md R22 + R22-schedule + promote #176/#179/#183; architecture.md:824 corrected; prd FR38/FR39/FR9/FR17. | Doc review. |
| **F22-06** stale comments | (subagent) read-only-sandbox comment sweep + attachments one-writer + event-count. tsc clean. | N/A (comments). |

## Live validation method
Container builds from the MAIN repo (`build: .`), so it does NOT contain worktree changes. Live
validation runs the WORKTREE dev server (`viberr-dev`, HMR, port 5173) on `docker-data` (the pass-22
fixtures: VIB project, agents incl. Web Researcher, KB, everything-MCP, users Arda/Mira/Deniz).
Procedure: stop `viberr-app-1` (dual-writer guard) → preview_start `viberr-dev` → validate → stop dev
server → restart the container for the owner.

## Not runnable in this environment
- `oxlint` (CI lint gate) is a devDependency but not installed in the worktree/container node_modules.
  tsc is kept clean (catches unused vars / most lint). oxlint runs in CI.

## Live validation results (dev server on worktree code + docker-data, 2026-08-21)
- **F22-02** PASS: schedule form has only `delayMinutes` (no backend/autonomy selects) + note "Runs on the operator profile deployed when it fires."
- **F22-11** PASS: opening a screenshot lightbox lands focus on the Close button (aria-label="Close"), not "Open original".
- **R22** PASS: capability-matrix modal reads "On Codex the file and command limits are advisory (its runs are not process-sandboxed), so the server-side delivery gate is what actually constrains what ships"; "Execute code or write to the repo" row now shows the Claude-enforced badge (moved to claude-only).
- **F22-08** live run in progress (VIB-4, Developer→Codex, host ~/.codex quota-blocked = same account).
- doc-sync tests (prd-sync, file-formats-sync) pass after canon amendments; tsc clean after comment sweep.
- **F22-08** PASS (LIVE, real quota failure): VIB-5 Developer→Codex run hit the real usage limit. Recovery packet now reads "Codex is over its usage quota… Retry on the other backend, or fix the credential" (quota class) + "Provider said: You've hit your usage limit… try again at Sep 18th, 2026 8:20 PM." Before F22-08 this was "Codex execution failed. Review its authentication and runtime configuration" + the useless stdin banner. End-to-end confirmed.

## Batch 2 validation (2026-08-21)
- Full suite **265 files / 4167 tests green**, tsc clean, copy-ban (em/en dash) gate green, app.css integrity+contrast gate green.
- **#183**: tsc proves the repointed import graph; 62 overlay/projection/agents tests green (behavior-preserving refactor). No `server/projections/*` file imports `features/agents` any more.
- **#177 broken-tiles**: 3 tests fire `img` error events → assert the placeholder swap (timeline thumb, side-panel grid) and the lightbox "could not be loaded" message, with the link/Open-original affordances intact.
- **Steer IME guard**: 2 tests — bare Enter runs the operator with trimmed steer text; Enter while `isComposing` does not, and a real Enter after composition ends does.
- **#176 egress note**: the coupling test now asserts the RENDERED `.cap-mnote` reason appears when the row pins and is gone when released.
- **F22-12 dedupe**: 2 tests — a verbatim final report is deduped (finding on the timeline once, audit `deduped: "duplicate-of-own-comment"`, not `droppedByGuardrail`); a report that adds text still posts.
- Live UI screenshots deferred: the running container serves MAIN code on docker-data (dual-writer hazard to run the worktree server concurrently), and these are deterministic render/CSS changes with direct test coverage. A live pass can be done on request by briefly stopping the container.

## Batch-2 LIVE UI validation (worktree dev server on docker-data, 2026-08-21, container stopped for the pass)
Ran the worktree (batch-2) code live against the real docker-data (2 projects, 5 tasks, 3 users). Screenshots captured.
- **#176 rendered egress reason — PASS (screenshot).** Edit Web Researcher → Collaboration: the "Search & fetch from the web" row is disabled (pinned) with the VISIBLE copy directly beneath it — "Required by Drive a live web browser: the browser is web egress. Set the browser to Human-only or Off to change this." Exactly one `.cap-mnote`, on the egress row, and every mode button on that row `disabled`. P14 satisfied live.
- **#177 broken-tile fallback + #8 SR label — PASS (screenshot).** Renamed one of VIB-2's two evidence PNGs on disk (route 404s the name the timeline event still references). Reload: that tile rendered the file-icon "preview unavailable" placeholder (no browser broken glyph), the anchor's accessible name read "page-….png (preview unavailable)", while the intact PNG rendered normally side-by-side. File restored immediately after; docker-data clean.
- **Steer input — PASS.** `.op-steer` present on active tasks (aria-label "Steer this operator run (optional)", maxlength 2000); the IME guard (`!isComposing && keyCode!==229`) is not visually triggerable in automation and is covered by the Chrome+Safari jsdom tests.
- **Live Claude agent run — PASS (operator behavior).** Created SAN-1 (Sandbox, read-only goal). The operator auto-invoked on create, cloned akin-ozer/viberr into the project `.repo-mirror` (first clone ~5 min, 162M full repo — slow but healthy; host reached GitHub fine), then ran 10 turns on Claude/sonnet using viberr's MCP toolkit (`mcp__viberr__get_task`, …). It triaged the task, engaged the Developer as deliverer, posted a faithful read-only directive ("Do NOT modify any files… no code changes are expected"), and raised a decision (waiting:human). Proves batch-2 code executes live and the operator coordinates correctly.

## Pending UCs — status after the live pass
- **UC-20 (continuity)** — NOT reproduced live. The continuity event is a RESUME-time probe (P13-D-2/FR22): it fires when a run is resumed with its SDK session gone. The operator run finished cleanly (no ask-human pause to resume), so there was no resumable run to delete-session-and-resume. Reproducing it needs a run that pauses (UC-19) then a session delete + resume. Covered by run-service.server.test.ts continuity tests.
- **UC-07 (no-change) / UC-19 (ask-human)** — NOT run live. Both need a Claude DELIVERER (the seeded Developer is Codex, quota-exhausted until Sep 18) plus non-deterministic agent behavior (produce no diff / call ask_human). A focused follow-up with a Claude-backed deliverer (or Codex quota restored) is the way to exercise them end-to-end.
- Container stopped for the pass, then restarted (healthy); writer lock released cleanly before restart (no dual-writer overlap).
