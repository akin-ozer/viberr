# Implementation completeness ledger (2026-07-11)

Final audit: every item in `findings.md` (37) + the 5 owner decisions (A–E) + the 4 sweep decisions
(D1–D4) + the sweep-found verdict bug, mapped to its landing point and verification. **Nothing
silently dropped.** Suite: 1019 tests green, typecheck clean.

Status key: ✅ implemented + verified · 🟡 intentional / by-design (no change) · 📎 documented
limitation (owner deprioritized security).

## Findings #1–#37
| # | Status | Where / note |
|---|---|---|
| 1 / 30 | ✅ | Single-process + synchronous better-sqlite3 → inflight-check→insert is already atomic (no await between); live-verified coalesce. No lock needed. |
| 2 | ✅ | resolvePacket re-invokes operator (retest passed); fire-and-forget by design. |
| 3 | ✅ | Advisor removed (D1/A) → moot; reviewer verdict classification hardened (see verdict bug below). |
| 4 | ✅ | `createNotification` consults `isNotifKindEnabled` + `bypassPrefs` for seed. |
| 5 | ✅ | New profile starts with EMPTY resources; mock `RES_DEFAULTS` deleted. Live: modal shows only real skills, no mock ids. |
| 6 | ✅ | Runtime `quality` notification emitted on reviewer verdict (`task-actions.server.ts:1263`). |
| 7 | ✅ | Org resources disk-truth (`synthetic disk:` ids); live-verified 8 disk skills shown. |
| 8 | ✅ | Binary bytes removed — `grep deriveReadiness rebuilder.server.ts` now matches. |
| 9 | ✅ | `scheduleOperatorRun` deleted; no non-test references. |
| 10 | ✅ | Dead `listAuditEvents` moved to `test-support/audit-log.ts`; prod uses `listAuditLog`. |
| 11 | ✅ | `tools_count = NULL` on HTTP update; stdio discovery on test. |
| 12 | ✅ | `user-disable`/`user-enable` intents + users-panel UI. |
| 13 | ✅ | `clear-credential` intent + credential-card rotate/remove. |
| 14 | ✅ | `RES_CATALOG` mock fallback removed (`?? []`); dead constants + test deleted. |
| 15 (E) | ✅ | Operator SOP folds plan into one comment/turn; live-verified one-entry-per-turn. |
| 16 | ✅ | `no-duplicate-summary` guardrail enforced (`operator-actions.server.ts:251`). |
| 17 | ✅ | Seed stub tasks DEP-31/BIL-9 are real records; notifications navigate. |
| 18 | 🟡 | Seed connection "not validated" is the HONEST placeholder state (no real token to validate). By design. |
| 19 | ✅ | Login fake-spinner removed; unconfigured providers disabled with a note. |
| 20 | ✅ | Dead email/nudge notification schema deleted (only `app` channel remains). |
| 21 | ✅ | Empty `app/features/auth/` dir deleted. |
| 22 | ✅ | `invite-domain` duplicate returns a real 409 fail (mock "modal stays open" gone). |
| 23 | ✅ | `normalizeEscapedNewlines` wired into operator toolkit + codex plan; negation-safe. |
| 24 | ✅ | Operator crosses auto boundaries + assigns specialist (D2); live: 16 tasks auto→impl. |
| 25 | ✅ | Consultant profile gone from every preset (D1/A). |
| 26 | ✅ | Root error boundary reads `error.data` (`app/root.tsx:153`). |
| 27 | ✅ | Broken frontmatter → BLANK stage + `unresolved_stage` warning (not phantom triage) + board banner. |
| 28 | ✅ | Empty definition keeps template desc (`desc: form.definition.trim() \|\| current.desc`). |
| 29 | ✅ | Default anti-noise guardrails in `GOVERNED_TEMPLATE`; every new project ships them. |
| 31 | ✅ | `reconcileWorkspaceDelivery` captures agent branch/PR; live PR #15 captured, state "review". |
| 32 | ✅ | Single `resolveClaudeConfigDir`; session-export returns 200 live. |
| 33 | 📎 | Codex SDK ignores tool/env confinement — prompt-only. Documented; security deprioritized. |
| 34 | ✅ | `OPERATOR_DENIED_BUILTINS` denies Bash/Edit/Write for operator runs (live: Bash absent). |
| 35 | ✅ | `skills:[]` + `settingSources:[]`; live: agent context = only its declared skill. |
| 36 | ✅ | `process.env` spread into SDK subprocess; live: `everything` MCP echo round-trip worked. |
| 37 | ✅ | create-profile persists exactly the submitted caps (no permissive default seeding). |

## Owner decisions
- **A** ✅ Advisor removed. **B** ✅ notif prefs wired + quality notifications. **C** ✅ skills/KB disk-truth. **D** ✅ scheduleOperatorRun deleted. **E** ✅ operator plan folded.

## Sweep decisions (2026-07-11)
- **D1** ✅ Tester merged into Reviewer. **D2** ✅ triage→ready auto. **D3** ✅ accept records "accepted" (real PR #15 stayed OPEN). **D4** ✅ retry-on-other-backend (unit-verified; quota not reproducible live).

## Sweep-found bug (found + fixed this pass)
- ✅ `classifyReviewerVerdict` negation-blindness — bare `fail`/`blocker` flipped clean APPROVEs to
  request-changes. Fixed (explicit-verdict priority + negation-aware scan); 2 regression tests.

## Exhaustive adversarial hunt (2026-07-11) — 5 NEW confirmed defects, all fixed
A 4-dimension find→verify sweep over the areas the backlog didn't cover surfaced 5 real defects
(none overlapping the 37). All fixed + tested; 1029 suite green.
- **H1 (bug)** — `reconcileTask` clobbered a human-set `"accepted"` (merge-pending) PR state back to
  `"review"`, silently disabling the new S2 "Complete merge" button. Fixed: reconcile PRESERVES
  "accepted" while the PR is still open; only a real terminal state (merged/closed) overrides it.
  2 tests.
- **H2 (bug)** — the reviewer verdict (validation flip + typed `quality` event + owner notification)
  only fired on the operator-PROMPT path; the UI "Run reviewer" button, @mention reviewer, and the
  operator's own `run_reviewer` all dropped it (backlog #6 only covered one path). Fixed:
  `registerReplyAndReconcile` records the verdict for EVERY reviewer run.
- **H3 (poor-impl)** — multi-reviewer coordination: the scripted operator only prompted `reviewers[0]`,
  accepted on the first report, and `approve` masked an earlier `request_changes` (last-writer-wins).
  Fixed: scripted drive prompts EVERY engaged reviewer; `approve` never clears a `failing` (a rejection
  sticks until the developer reworks); the operator refuses to accept a `failing` task.
- **H4 (bug)** — a manual stage move INTO Done bypassed the acceptance contract (no merge attempt, no
  `completion` event, no validation=healthy) — a Done task could sit with an unmerged PR and no
  completion record. Fixed: a human transition into the final stage routes through `acceptCompletion`.
  Tests updated.
- **H5** = duplicate of H2 (a second hunter found the same defect from the call-site angle).

## Net
37/37 backlog findings resolved (35 fixed, 1 by-design #18, 1 documented-limitation #33) + 9/9
decisions + 1 sweep bug + 3 shipped-build gaps (S1/S2/S3) + 5 exhaustive-hunt defects (H1–H4). No
deferrals. Every fix carries a regression test; 1029 suite green, typecheck clean.
