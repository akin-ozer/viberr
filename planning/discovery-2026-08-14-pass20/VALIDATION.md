# Pass 20 — Validation record

The full pass-20 fix set (branch `claude/viberr-app-inspection-34388a`, 10 commits) was
validated by three independent means: the test suite, a live rebuilt container, and UI
screenshots.

## Code gate (every band + final)
- `react-router typegen && tsc` — clean.
- `vitest run` — **3878 tests across 260 files, all green**, confirmed on ≥3 consecutive runs
  (no flakiness). New gates added this pass and passing: the toast-honesty scanner (D5),
  plus the pre-existing app.css integrity/contrast gate (80/80) and copy-ban gate.
- Every fix was canaried during implementation (revert → the guarding test goes red → restore).

## Live container validation (rebuilt from the fixes)
The production image was rebuilt from the fix branch (`docker compose up -d --build`) against a
freshly-wiped data root (the squashed baseline gained `task_projections.acceptance`,
`task_projections.continuity`, `org_mcp_servers.first_success_at/heuristic_warmups`, and the
`model_availability` table — all verified present in the running DB). Then:

- **F20-2 (init + zombie reaping)** — `HostConfig.Init = true`; **0 defunct processes** at boot
  (was 8 `<defunct>` chromium/crashpad before the fix).
- **F20-7 (HIGH secret leak)** — an MCP command echoing its credential renders the error as
  **`CRED=[redacted]`** in the row (screenshot `v-04-cred-redacted.png`); a <8-char credential is
  **refused at save** ("too short — enter at least 8 characters", `v-02-shortcred-refused.png`).
  No plaintext anywhere.
- **F20-8 (HIGH lock self-lockout)** — SIGKILL'd the node app; the container rebooted and the log
  shows **"taking over a stale data-root writer lock"** (reclaimed on the `procStartedAt`
  comparison, `force:false`) — no "Refusing to boot". Before the fix this bricked the container.
- **F20-9 (HIGH operator card ⇄ D1)** — the supervised operator's "Accept completion into Done"
  renders under **RECOMMENDS ONLY** (not Acts directly), with the inline reconciling exception
  note (`v-05-agents-operator-card.png`).
- **F20-22** — a dying stdio MCP command shows **"exit code 2"** in its row error.
- **R20-3 (provider error surfacing)** — a failed Codex run's packet carries a **"Provider said"**
  observation with the exact provider sentence ("Failed to refresh token: … already used …"),
  instead of the old generic "Codex execution failed. Review its authentication…".
- **R20-1 (packet resolve + re-queue)** — confirming a failure-packet recovery option resolves the
  packet (no repeat confirms) and re-queues the operator.
- **F20-5 UI** — while a decision packet is open, "Run operator" is disabled with
  **"Open decision — resolve it before running the operator."**
- **N20-4** — PR #168's body renders the task line as **plain text** ("VIB-1 — …"), not a relative
  link that 404s on github.com (no absolute origin configured on this deployment).
- **D8** — the KB tab shows the full empty-state pattern ("No knowledge bases yet. A knowledge
  base is a folder of docs agents read live while they work. Add one with New above, then grant
  it to an agent profile.").
- **C6** — removing an MCP server shows an outcome-naming confirmation dialog.
- **C4 / C2 / C3** — the board reads "0 waiting on a human" (dropped "decision"); the merged VIB-1
  card shows the **merged** pill with no stray "awaiting verdict" validation pill.

### Full governed delivery loop — end to end, real merge
VIB-1 ("Validation marker") on the rebuilt image: operator triage → deployed Developer (Claude,
after the Codex refresh-token env issue) → Developer committed exactly
`test-artifacts/pass20-validate.txt` = "pass-20 rebuild validated" → server delivery → **PR #168
opened** → Reviewer clean verdict → operator acceptance recommendation → the AcceptConfirm
ceremony (disclosed merge target, revision `7ba0be81b04b`, verdict, one-way) → **PR #168 MERGED on
GitHub**, task → Done. The whole governance chain is intact under all 44 findings' worth of change.

### Environmental notes (not product defects)
- The fresh container's **Codex CLI auth** hit "refresh token already used" (the host `~/.codex`
  seed token was consumed) — surfaced HONESTLY by R20-3. Loop completed on the Claude backend.
- The GitHub connection had to be re-attached after the aggressive F20-8 crash test (a `kill -9`
  can leave the most-recent org-store write un-checkpointed); connection add + credential attach
  then succeeded and the loop ran to a merged PR. Both are test-harness artifacts, not regressions.

## Owner rulings gathered this pass
R20-1 … R20-9 (recorded in `docs/architecture/decisions.md` 76–83 and `FINDINGS.md`).

## Held out of scope (owner ruling R20-5)
D7 (Decision-Packet impact/confidence/severity fields), D10/D11 (Continuity-panel escalated/paused
states, execution-truth continuity), D12 (skeleton loaders) — pure never-built PRD features.
