# Pass 22 — implementation plan (2026-08-21)

Ordered, self-contained work items derived from [FINDINGS.md](FINDINGS.md), the doc-agent probe
lists, and [QUESTIONS.md](QUESTIONS.md). Each item: scope, files, approach, validation, canary.
No migrations / no backwards-compat (owner: breaking allowed). Tests may be touched critically.

Legend: [CLEAR] = implement now · [ASK] = needs owner ruling first · [DOC] = canon/doc fix.

## Owner decisions (2026-08-21 batch)
- **Proceed autonomously** on clear fixes + canon; hold ambiguous.
- **Schedule pickers → REMOVE** (match R21-9): scheduled runs resolve the LIVE deployed profile at fire time. Amend FR39. (was T2-1)
- **No OS sandbox** (Codex read-only/workspace-write; Claude confinement) — "viberr itself is a sandbox." NEEDS a precise boundary confirm (OS-sandbox only, vs also viberr's capability tool-limits) before coding — ask when reached. Supersedes T1-3 (AD-1 dissolves if the sandbox is gone).
- **Promote load-bearing rulings**: #176 browser→egress (+ amend 75a), #179 attachments-drop contract, #183 live-backend display law; amendment notes for #180/#182/#186 styling. (T2-2)

## Tier 1 — correctness / honesty (implement first)

### T1-1 [CLEAR] F22-08 Codex failure misclassification (HIGH)
- Problem: `classifyCodexFailure` runs on the SDK's thrown error ("exited with code 1: Reading prompt from stdin…"), which lacks the real reason; the usage-limit branch never matches → generic "review authentication" message + useless providerText. The real message ("You've hit your usage limit… try again Sep 18") is in the `turn.failed`/`error` stream event the loop already receives.
- Files: `app/server/runtimes/codex-runtime.server.ts` (run loop ~678-746, classifyCodexFailure ~415-475).
- Approach: capture the last fatal stream event's `error.message`/`message` (from the `turn.failed`/`error` branch at :697) into a `lastFatalMessage`; pass it (redacted) to `classifyCodexFailure` as the primary text, falling back to the thrown error only when no fatal event was seen. Ensure providerText prefers the event message.
- Validation: unit test feeding a `turn.failed` with "usage limit" text → expect kind:"quota" + retry date surfaced. Live: re-run a Codex task, confirm task.md shows the usage-limit message not the generic one. (Codex is quota-blocked, so live will actually reproduce this.)
- Canary: revert → generic message returns.

### T1-2 [ASK→likely CLEAR] F22-10 PR body stale change-summary/evidence stats (HIGH)
- Problem: PR #187 body said "3 file(s) changed (+214/-16), 3 commit(s)" while the actual diff was 1 file/+5/−0. Stats come from a reconcile/mirror snapshot, not the actual pushed diff. Edge-triggered by task-key reuse colliding with a stale remote branch (the app's own clean-sheet dev loop).
- Files: PR-body/evidence builder in the delivery path (`app/server/tasks/task-actions.server.ts` performDelivery/openTaskPr ~3703/:223; `app/server/github/push-workspace.server.ts`).
- Approach: compute change-summary + evidence from the actual delivered diff at push time (workspace branch vs merge-base with origin/main), never from the reconcile snapshot; refresh the reconcile view synchronously post-delivery so the GitHub panel + delivery report agree.
- Owner Q10: also add a display-layer collision guard (don't present a name-colliding remote branch's commits as the task's until viberr has a push record for it on this task)?
- Validation: live — deliver a task whose branch name collides with a stale remote branch; confirm PR body stats == actual diff. Unit: stat builder given (base, head) returns real numbers.

### T1-3 [CLEAR] F22-03 read-only Codex evidence "Posting files" persona honesty (MED)
- Problem: evidence-granted read-only Codex runs get the attachments-drop persona while the sandbox (`additionalDirectories` only at workspace-write) blocks the copy. Also the resume-parity gap (AGENTS-RUNTIME probe #1): resumed evidence Codex loses the writable dir + persona.
- Files: `app/server/tasks/specialist-run.server.ts` (persona emit ~1403-1406, resume path ~2429-2439), `app/server/runtimes/codex-runtime.server.ts` (:646-652).
- Approach (owner Q4 option B, smaller): gate `attachmentsDropSection` on the sandbox actually being writable for this run (workspace-write OR Claude), so a read-only Codex run never promises what it can't do. Carry `attachmentsWritableDir` + persona through the resume path too.
- Validation: unit — read-only Codex reviewer with evidence → no drop persona; workspace-write → persona present. Fix resume parity: fresh+resume both consistent.

### T1-4 [CLEAR] F22-06 stale source comments (LOW)
- `task-attachments.server.ts:11-12` "exactly one writer" (now two since #179); run-operator stale picker comment; `agents-query.server.ts:143` cites moved line; `decision-packet.tsx:133-137` describes never-shipped AcceptDisclosureProvider; `task-file.schema.ts:44` "10 timeline event types" over 11-member array. Refresh all.

## Tier 2 — coherence / product (some need owner)

### T2-1 [ASK] F22-01/F22-02 run-operator + schedule backend/autonomy overrides (owner Q2, Q3)
- run-operator route parses backend/autonomy no UI sends (backend unclamped); schedule modal still picks both. Await owner: tighten route (drop/clamp backend) + decide schedule pickers (keep w/ FR39 scope note, or remove + resolve live profile at fire time).
- Files: `app/routes/project.task.tsx:872-900`, `app/features/task-detail/task-main-sections.tsx:414-451`, `app/server/tasks/schedule.server.ts:114-166`.

### T2-2 [ASK] F22-04 browser→egress coupling ruling (owner Q1)
- Promote to numbered ruling + amend ruling 75(a); confirm auto-flip intended on all 3 save paths. If yes: `docs/architecture/decisions.md` new ruling + amendment note.

### T2-3 [ASK] F22-09 no backend fallback on outage (owner Q11)
- Profile pins exactly one backend now, so possibly moot. If owner wants outage-fallback: run-service tries next listed backend on a hard backend-unavailable (not task failure).

### T2-4 [CLEAR] F22-11 lightbox initial focus (LOW a11y)
- `app/features/task-detail/attachment-lightbox.tsx`: focus the dialog/Close on open, not the first focusable ("Open original"). Verify focus-restore to the triggering thumb on close.

## Tier 3 — doc-agent probe items (verify live, fix if real)

- [VERIFY] #177 broken-image tiles for a viewer who sees the timeline but fails requireProjectMember (org-admin-override viewer): `<img>` 403 → broken tile. Probe least-privileged viewer on a task with screenshots; if real, gate attachment thumbnails on membership or render a fallback.
- [VERIFY] P14 doctrine: #176 pinned egress row explains itself only via title/aria-label on disabled radios; disabled-reason must be RENDERED copy. If real: render the reason inline.
- [VERIFY] Bare-Enter on `.op-steer` starts a real operator run + posts a public @operator comment (composer requires ⌘/Ctrl+Enter elsewhere). Inconsistent + accidental-run + steer-comment-lands-but-runOperator-throws seam (dangling mention). Decide: require modifier, and/or don't post the comment until the run is accepted.
- [VERIFY] Nested-interactive: `[![alt](attachments/x.png)](url)` → `.md-img-btn` <button> inside <a> (axe nested-interactive). Fix markdown embed rendering.
- [VERIFY] Attachments store: no quota/retention; LIST_CAP=100 hides files past 100 while on disk; mtime-window attribution may cross-attribute concurrent deliverer+reviewer files.
- [VERIFY] Layering inversion #183: `projections/{task,board}-query.server.ts` import from `features/agents/*` (server→features) + project.md reads on hottest loaders w/ silent empty-map fallback. Measure board latency; consider moving the shared rule to a server module.
- [VERIFY] F22-12 agent double-post (mid-run post_comment + final envelope reply). Decide: dedupe or intended.

## Tier 4 — canon amendments [DOC] (owner Q5,6,7,8)
- architecture.md:824 "attachments/ never implemented" → CORRECT (attachments real since R19-19). CONFIRMED FALSE — fix regardless.
- prd.md/ux-spec: add attachments + browser capability as FRs (Q7); operator-card + owner-cell updates (#185/#186); amendment notes for #176-186.
- Rulings digest: promote commit-only rulings (Q8), FR38 viewer-floor (Q6), held D7/D10/D11/D12 (Q5).

## Validation protocol (every item)
1. Code change + canary (revert → failure returns).
2. Unit/integration test (touch tests critically where needed).
3. Live: rebuild container or HMR, reproduce via browser/API, screenshot proof.
4. `npm run typecheck` (tsc is a required gate — build ≠ typecheck) + `npm run lint` (CI gate, ruling 86) + `npm test`.
5. Update this doc's item status + FINDINGS status.
</content>

## Implementation progress (2026-08-21)
DONE + tested (full suite 265 files / 4158 tests green, tsc clean):
- F22-08 Codex failure misclassification — classify on the streamed turn.failed reason (codex-runtime.server.ts). +2 unit tests.
- F22-10 PR body stale stats — change-summary + evidence from live base...head compare (pr-open.server.ts deliveredDiffStats). +2 tests.
- F22-02 schedule pickers removed (R22-schedule) — schema/server/route/UI; run resolves live deployed profile. Tests updated.
- R22 Codex OS sandbox removed — resolveCodexSandboxMode never read-only; egress-gated→workspace-write, autonomous-deliverer→danger-full-access; execute-code→claude-only enforcement; matrix copy updated. Resolves F22-03 (reviewers workspace-write can write attachments).
- F22-01 run-operator route no longer reads backend/autonomy overrides (crafted-POST backend override closed).
- F22-11 lightbox Close autoFocus.
IN FLIGHT (subagents): canon rulings (R22, R22-schedule, promote #176/#179/#183, amend architecture.md:824 + prd FR38/FR39/FR9/FR17); stale-comment sweep (read-only-sandbox comments, attachments one-writer, 10-event-types count).
NEXT: container rebuild + live validation (schedule modal has no pickers; Codex usage-limit message shows retry date; lightbox focus; smoke test). Then oxlint (CI-only, not installable here).
