# Pass 25 — findings (my own, live + code)

Fresh discovery/bug-hunt on the post-pass-24 product (main `7cf113a`, PR #200 merged).
Branch: `fix/pass25-discovery` off main. Container `viberr-app-1` healthy on :5173 (built from main).

Severity: **HIGH** = user actively misled or work/data lost; **MEDIUM** = confusing/wasteful/real
gap w/ workaround; **LOW** = polish. Each item: file:line + concrete failure scenario + fix direction.
Subagent-authored audit docs (BACKLOG-RECONCILE, FRESH-HONESTY-AUDIT, PARITY-CAPABILITY-AUDIT) are
separate; confirmed items get promoted here.

---

## F25-1 [MEDIUM, CONFIRMED] Capability-matrix footnote still says the Codex operator "cannot" reach the web — pass-24 B-2 made it honor the grant

- **Where:** `app/features/agents/capability-matrix-modal.tsx:272-276` (the "what differs between the two runtimes" list, last `<li>`).
- **Copy:** "The Claude operator can reach the web (WebFetch/WebSearch) when **Search & fetch from the web** is granted; the Codex operator cannot."
- **Runtime truth (post-#200):** `app/server/runtimes/codex-runtime.server.ts:709-728` — for an operator, `networkAccessEnabled=false` (OS-sandbox net off, unrelated), and `webSearchMode="disabled"` is set **only if `spec.webSearchWithheld`**. So a Codex operator that HOLDS `use-web-search-fetch` now gets web search, exactly matching the Claude operator. This was pass-24 ruling B-2 (owner: "honor grant on Codex"), and the code comment at :711-717 explicitly says the old unconditional-disable "used to dishonour the grant on Codex operators while the matrix rendered the cell green."
- **Failure scenario:** An admin granting `use-web-search-fetch` to a Codex operator reads this footnote and concludes the grant is inert on Codex, so they either don't grant it (losing a capability that now works) or believe the operator is web-less when it is not. The pass-24 fix changed behavior but left the explanatory footnote asserting the opposite — a coherence regression *introduced by* the fix.
- **Fix direction:** Rewrite the footnote to say both operators honor the grant (the Codex operator's OS-sandbox network stays off, but web search follows the `use-web-search-fetch` grant just like a specialist). This is the same statement the matrix's own comment at codex-runtime:711-717 makes.
- **Meta:** classic "audit the last pass's fixes" — B-2 flipped runtime behavior; this rendered copy is its stale twin. Worth a copy-ban/coherence test that ties operator-web copy to the runtime rule.

## F25-2 [MEDIUM, from honesty audit — verify before fix] Archived-project review-queue count zeroed but rail badge still counts → "Review 1" rail vs "0 tasks / no review work"

- **Where:** `app/server/projections/review-queue.server.ts:118-136` (D-1 fix) vs the rail badge in `app/routes/project.tsx:139-147`.
- **Symptom:** Pass-24's D-1 fix correctly excludes an archived project's review-stage tasks from the actionable "waiting on acceptance" list AND zeroes the informational `working`/`total` counts — but the rail badge was never patched and still counts the same task. An archived project with a task stuck in Review shows "Review 1" in the rail, but opening it shows "0 tasks at the review boundary… No review work in flight."
- **Class:** the exact badge/queue-parity defect (WI-1/F19-9) this codebase already fixed once — a fresh recurrence introduced by pass-24's own D-1.
- **Fix direction:** make the rail badge read the same archived-aware count as the queue (single source), or exclude archived from both consistently. Add a cross-check test tying the rail count to the queue's `total`.

## F25-3 [MEDIUM, from honesty audit — verify before fix] Codex operator static SOP (`operator.definition.md:12`) contradicts the dynamic scratch-dir prompt after pass-24 B-1

- **Where:** `app/server/seed/assets/operator.definition.md:12` (static "ALWAYS present" SOP) vs `workspaceSection()`'s `isolatedWritableRoot` branch (the B-1 dynamic prompt).
- **Symptom:** Pass-24 B-1 moved the Codex operator's writable cwd to an isolated `.operator-scratch/` sibling and correctly described it in the dynamic `workspaceSection()` block. But the static baked SOP line still says "your working directory holds… task.md… AND a read-only checkout" — directly contradicting the dynamic block injected later in the SAME Codex system prompt. B-3's own edit in this PR fixed an adjacent sentence in this file but missed this one. Claude is unaffected (its workspaceSection text still agrees with the SOP).
- **Consequence:** the Codex operator is told two different things about its own cwd in one prompt — model confusion about where task.md is and whether it's writable.
- **Fix direction:** update `operator.definition.md:12` to be backend/posture-neutral (or defer the cwd claim to the dynamic block). NOTE: editing a shipped asset requires bumping `PRIOR_SHIPPED_HASHES` with the OUTGOING hash (pass-24 trap) and syncing the live `docker-data/agents/definitions/operator.md`.

## Live observations (candidates — verify during implementation)

- **OBS-1 [count]:** QA-25 Agents page showed "0 tasks with a live operator" while VQ-1's operator run was actively preparing/cloning (a real run existed, runId assigned). Verify whether the "live operator" count only includes runs past the reservation/clone phase — if a preparing operator run isn't counted, that's a coherence gap on the Agents stat card. (`app/features/agents/*` live-operator count source.)
- **OBS-2 [label]:** execution-profile middle section is labeled "REVIEWING AGENTS" on a task with no engaged supporting agent (VQ-1 at Triage/Review) but "SUPPORTING AGENTS" on VIB-4 (In Progress, Developer engaged as supporting). Confirm the label logic is intentional (reviewers vs supporting) and coherent across stages.
- **OBS-3 [efficiency, not a bug]:** repo mirror is per-PROJECT (`/data/projects/<slug>/.repo-mirror/<owner>__<repo>.git`), so every new project on the same repo re-pays the full clone (~5 min for akin-ozer/viberr's history). A shared per-repo mirror across projects would save the repeated cold clone. Owner call (isolation vs speed).
- **OBS-4 [minor coherence]:** after a "Retry on Claude" recovery on a Codex profile, the live-run header still shows "Codex Dev · Implementation (Codex)" while RUNTIME correctly shows sonnet. Profile identity vs run backend — arguably fine (RUNTIME field is authoritative), but the "(Codex)" role label next to a sonnet runtime can read oddly. Low priority.

## Parity/capability findings (from PARITY-CAPABILITY-AUDIT.md) — I re-verified each in code

All 5 HIGH verified REAL by me (traced the seam, not the finder's word):
- **F-P8 [HIGH, headline] VERIFIED** — shared workspace (`taskCloneDir` has no engagement/run component,
  `specialist-run.server.ts:2398-2406`) + Codex reviewer gets `workspace-write` (`resolveCodexSandboxMode`,
  reviewer is `!isDeliverer` → workspace-write; `codex-runtime.server.ts` never reads `disallowedTools`
  → withholding is advisory) + delivery `git add -A` sweeps the whole shared tree gating only on the
  DELIVERING profile's grant (`push-workspace.server.ts:556-616`). ⇒ a write-withheld Codex reviewer's
  file edits can ship into the deliverer's PR under the deliverer's identity, no authorship check. The
  reviewer prompt even claims "The tool layer blocks these" (false on Codex, `specialist-run.server.ts:2218-2226`).
  Fix options: per-engagement worktree / diff-vs-deliverer-authored / stash-reset supporting runs / fix the
  false prompt claim. **This is the most important pass-25 finding.**
- **F-P9 [HIGH] VERIFIED** — `markMcpServerUnreachableFromRun` UPDATEs a shared `org_mcp_servers` row by
  name (no backend column, `resources.server.ts:1750`); B-4 Codex pre-flight drops the credential
  (`specialist-mcp.server.ts:265-296`) → a credential-at-startup stdio server fails → shared `up=0` →
  corrupts Claude's health + Settings + the next Claude run's disclosure. Fix: retry-with-credential before
  writing, or add a per-backend health dimension.
- **F-P1 [HIGH→MEDIUM] VERIFIED** — profile-detail `CapColumn` (`agents-page.tsx:233,808-810`) renders
  capability rows with NO `capabilityEnforcement` caveat (grep-confirmed absent), unlike matrix + editor.
  The surface an admin lands on first shows a withheld Codex cap with no "advisory on Codex" note.
- **F-P3 [HIGH→MEDIUM] VERIFIED** — `· auth: configured` (`resource-rows.tsx:250`) is unconditional/
  backend-blind; the credential is dropped on Codex runs, so it's true only for Claude. No caveat at
  config/list/grant time. Fix: backend-aware caveat like the matrix prose.
- **F-P5 [HIGH→MEDIUM] VERIFIED** — Codex operator default-branch read is `git show origin/<default>`
  "no fetch, no network" (clone-time ref, `operator-run.server.ts:2686-2695`) with no staleness caveat,
  while Claude's `read_default_branch_file` refreshes the mirror every call + self-discloses staleness
  (`operator-repo-read.server.ts:32-45`). Long-lived Codex-operator task → VIB-7 false-positive class
  reintroduced asymmetrically. Fix: add a fetch, or add the staleness caveat to the Codex prompt.

MEDIUM/LOW (took finder's traced word; spot-verify at implementation): F-P2 (policy counts backend-blind,
`MatrixProfile` drops `backends`), F-P4 (browser persona says "take screenshots" but Codex omits image
results — undisclosed), F-P6 (`flag_context_conflict` Claude-only, absent from `OPERATOR_PLAN_TOOLS`),
F-P7 (refused-action narration guaranteed on Codex, optional on Claude), F-P10 ("Run inputs" console claims
tool denial that didn't happen on Codex), F-P11 (Codex envelope re-parse ungated can truncate a plain
prose reply). Full detail: `PARITY-CAPABILITY-AUDIT.md`.

## Confirmed-FIXED live (pass-23/24 items verified working in the running app — do NOT re-open)
- **D1** (slow first-clone honest label): live — strip reads "Cloning akin-ozer/viberr · first task in this project, this can take a few minutes."
- **B1** (editor per-capability enforcement scope): live — new-profile editor shows "ADVISORY ON CODEX" tags on repo/execution caps for a Codex-backed profile.
- **C9** (storage visibility + periodic reclaim): live — Instance settings shows "N GB free of M (X% used). automatic cleanup runs every 6h; last freed …".
- **Full acceptance ceremony (R15-1)**: live — accept dialog names MERGES PR#/into main, REVISION sha, VERDICT, "merging is one-way." VQ-1 accepted → real merge of PR #203.
- **Codex-fail graceful recovery (B2-adjacent)**: live — Codex quota-fail raised a clean blocked-decision packet with the provider message + 5 recovery paths; "Retry on Claude" switched the backend and re-ran.
