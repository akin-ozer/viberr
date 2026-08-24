# Pass 27 — implementation record (2026-08-24)

Baseline: origin/main `84df795` (pass 26). Edited in the WORKTREE (`viberr-app-inspection-e1b87f`),
branch `pass26-fixes`. **Container rebuilt to 84df795 at pass start** for live testing.

## Gates (all green)
- **Full suite: 287 files · 4453 tests pass** (+9 from pass-26's 4444; no regressions).
- **tsc: clean.**
- **oxlint: 25 baseline (0 new anti-slop).**
- **Live UI: F27-L2 validated end-to-end** on the hermetic dev server (:5174, worktree code).

## Method note (why the change set is small)
The app is very mature (pass 26). Discovery surfaced ~16 candidate findings; **adversarial verification
subagents refuted or reclassified most** as by-design / already-disclosed / owner-ruled. Only the items
below survived verification as real + actionable. This is the intended outcome of skeptical verification —
not fixing correct behavior. (See FINDINGS.md for every verdict + citation.)

## Shipped fixes

| ID | Sev | What shipped | Files | Tests |
|----|-----|--------------|-------|-------|
| **F27-L2** | MED (real, empirically confirmed) | The capability MATRIX lied about repo-write: a scoped-only delivery grant (create/commit/open-PR granted, headline `execute-code-or-write-repo` ABSENT — reachable on a hand-edited / non-standard-save profile) rendered "Not granted" while the RUNTIME granted full repo-write. Routed the display through the SAME inference the runtime uses (`specialistGrantModes`, exported from specialist-tool-policy). Respects an EXPLICIT `off` (unlike normalizeDeliveryGrants). | agents-query.server.ts, specialist-tool-policy.ts (export+rename grantModes→specialistGrantModes) | +2 (display==runtime for scoped-only; explicit-off still off). **Live-validated**: matrix now reads "Acts directly". |
| **F27-O1** | MED (test-coverage) | R26-1 (task metadata → operator) had ZERO test coverage. Added coverage. | operator-actions.server.test.ts, operator-run.server.test.ts | +3 (snapshot carries priority/labels/dueDate; plain-task defaults; system prompt has the "Triage signals (advisory)" note). |
| **F27-O3** | MED (drift guard) | Operator Claude-toolkit and Codex-plan-toolkit are two hand-maintained lists with no shared generator (no drift TODAY). Added a parity test. Documented the one DELIBERATE divergence (nothing-granted → Codex enum can't be empty → full fallback, refused visibly). | operator-toolkit.server.test.ts | +3 (parity for granted/mixed; the nothing-granted fallback). |
| **F27-B1** | MED (honesty) | The retry-on-other-backend recovery option claimed "The switch sticks, and later prompts follow it" — FALSE for a DEPLOYED profile (later prompts follow the live profile backend; the snapshot is honored only for an UNDEPLOYED profile). Corrected the user-facing copy + two stale code comments + a misleading test name. | task-actions.server.ts, specialist-run.server.test.ts | (flow tests already cover; copy is a string) |
| **F27-L1** | MED→small (nuanced, safe-direction) | `acceptanceBlockReason`'s comment claimed "Only two of its gates stay out" — it omitted the third (`noChangeWorkRefusal`, a LIVE async GitHub probe the sync projection can't run; it fails SAFE). Corrected the comment + added a safe-direction regression test. | rebuilder.server.ts, rebuilder.server.test.ts | +1 (a PR-less delivered task is never projected acceptable). |

## Refuted / by-design (NOT touched — see FINDINGS.md)
- **F27-P1** (Codex repo-write advisory): owner-ruled R22/#93, disclosed in 4 UI surfaces + canary test.
- **F27-P3** (MCP tool-name casing): vendor transform, disclosed, zero shipped assets name tools literally.
- **F27-O2** (Codex plans "non-transactional"): deliberate abort + timeline disclosure; steps are valid
  shared-core mutations (resumable, not corrupt); the "silent no-op" claim was flatly wrong (narrated noop).

## Deferred to owner (product decisions — flagged, NOT implemented)
- **F27-L3 / Q26-1** — should urgent/overdue task metadata NUDGE the operator (re-triage / priority), or
  stay advisory-only? `setTaskMetadata` never re-invokes the operator today; R26-1 is advisory-only by design.
- **F27-B1 behavior** — should the backend switch actually STICK for later runs (re-pin / task-level pin),
  or is one-shot-then-revert-to-profile intended? (I corrected the copy to match the CURRENT behavior.)
- **F27-Q1** — task keys are letters-only (2-4). Allow alphanumeric (JIRA-style "V27")? Deliberate?
- **F27-O5** — should the operator snapshot carry explicit verdict/validation state, or keep inferring
  review outcome from the 6-event/1500-char timeline window?
- **F27-P2** (minor) — optional 1-line agent-prompt disclosure that a Codex run dropped an MCP credential
  (already disclosed at every admin surface; the agent prompt itself is silent).
- **F27-U1** (UX) — first agent run per project does a ~4-min silent bare-mirror clone with no progress bar.
- **F27-U2** (LOW) — "pull_request:write unproven (verified on first use)" never flips to proven after a
  successful PR open (proven only by the opt-in VIBERR_GITHUB_WRITE_PROBE, or resolves a violation not the label).

## ADDENDUM — owner decisions (2026-08-24, answered live)
- **Metadata → operator: KEEP advisory-only.** No change (R26-1 stands; F27-L3/Q26-1 resolved).
- **Task keys: KEEP letters-only.** No change (F27-Q1 resolved).
- **Backend retry: MAKE THE SWITCH STICK.** → IMPLEMENTED. This SUPERSEDES the copy-only F27-B1 fix:
  - New per-engagement `pinnedBackend` field (task-file.schema.ts engagementSchema + agentRefSchema, `.nullable().optional()`).
  - Resolution (specialist-run.server.ts): `backendOverride ?? pinnedBackend ?? live-deployment ?? snapshot` — a
    stuck pin wins over the live profile, but only a deliberate retry sets it (a plain profile edit still takes effect).
  - Persist: the retry run sets `engaged.pinnedBackend = backendOverride`.
  - Display: `withLiveAgentBackends` (task.server.ts) skips a pinned agent (+ AgentRender.pinnedBackend, mapAgentRef)
    so the exec-profile/board card shows the pinned backend, matching what runs.
  - Copy reverted to "The switch sticks: later prompts on this task follow it." (now accurate) + comments updated.
  - Tests: specialist-run (retry pins → a later no-override run resolves to the pin) + task.server (display keeps the pin).

Gates after backend-stick: **287 files · 4454 tests** · tsc clean · oxlint 25-baseline.

## Still deferred to owner (not asked this pass)
- F27-O5 (operator snapshot: explicit verdict state vs timeline inference)
- F27-P2 (optional agent-prompt disclosure that a Codex run dropped an MCP credential)
- F27-U1 (first-run ~4-min silent clone, no progress bar)
- F27-U2 ("pull_request:write unproven / verified on first use" never flips after a real PR open)
