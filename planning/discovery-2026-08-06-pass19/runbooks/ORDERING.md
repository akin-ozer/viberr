# Pass-19 runbook execution order (UC-06..UC-28) — state dependencies

Written by the completeness critic, 2026-08-06. Source of truth for WHY each constraint
exists is the named runbook's Preconditions section; this file only fixes the ORDER.

## Shared state the order must protect

| Resource | Consumed by | Hazard |
|---|---|---|
| **VC-5** (review, no PR, open F19-21 packet, `ownerUserId: null`) | UC-20 Arm A (byte-equivalence), UC-10 (ownership probes), UC-09 (@operator leg), UC-24 (mention comment) | UC-20 Arm A asserts the exact F19-21 store shape; every later consumer appends timeline/comment bytes. **Nobody may resolve VC-5's packet — it is standing F19-21 evidence AND UC-20 input.** |
| **VC-2** (triage, `input_required`, open scoping packet, title `Improve the docs`) | UC-23 (hand-edit + restore), UC-18 (schedule cancel/fire arms), UC-08 (reference only) | UC-18's FIRE arm runs a supervised operator turn on VC-2 that may post a comment / re-affirm the packet; UC-23 needs the stable title+packet. |
| **VC-1 / VC-4** (Done, merged) | UC-18 (VC-1 read-only terminal guard), UC-09 (VC-4 comment leg) | Read/append only — no constraint beyond "don't archive them". |
| **Users Elif + Deniz, project `pass19-rbac-probe`** | created in UC-11; needed by UC-09, UC-10 (negative controls), UC-12, UC-24 (scoping leg), UC-26 (Elif creates the override-probe project) | UC-11 is the bootstrap; nothing that needs a second/third session can precede it. |
| **PR #149 contention — RESOLVED** | (env brief was stale) | UC-06 and UC-07 no longer share a PR: each creates a fresh probe task + fabricated workspace + its own PR. Serialize them anyway (reconciler divergence notes, F19-19 duplicate-note hazard) and note UC-07 step 8 (DG-1 probe) leaves a fresh OPEN PR — close it in UC-07 cleanup before any counter-sensitive check. |
| **UC-22's archived task** | UC-18 Arm D (`skipped-archived`), UC-24 (live F19-9 rail-badge check wants an archived task in the store) | UC-22 must precede UC-18 Arm D and UC-24. UC-22's own preconditions add the schedule that its archive must cancel (P14-RV-03). |
| **Codex health (F19-6 clone exit-128)** | UC-16 characterizes it; UC-12/17/19/22 carry the doc-writer fallback | Run UC-16 before the Codex-dependent UCs so the fallback decision is informed, not improvised. |
| **main branch** | UC-25, UC-19, UC-17, UC-07 all end in (or probe) a REAL merge | Serialize all real-merge UCs; never run one while a specialist run is in flight elsewhere (single-writer store, F19-15 one-run-per-task). |

## Recommended order

**Phase 0 — bootstrap (no task mutations)**
1. **UC-11** — creates Elif's password, Deniz (viewer), `pass19-rbac-probe`. Keep all three
   (UC-09/10/12/24/26 reuse them). While here: also probe the six config-surface child
   loaders with `?_routes=` as a non-member (new rbac-capability HIGH, 403-vs-404 oracle) —
   one curl per route, zero state.

**Phase 1 — byte-sensitive refusal probes on parked tasks (mutate least, run first)**
2. **UC-20 Arm A** — VC-5 refusal probes; must run before anything else touches VC-5.
3. **UC-10** — VC-5 ownership take/release; ends with `ownerUserId: null` restored.
4. **UC-26** — Elif-only project + org-admin override audit (needs UC-11; VC-* untouched).
5. **UC-09** — comments on VC-4 + VC-5 (@operator leg must NOT resolve VC-5's packet).
   Also seeds the mention rows UC-24 needs.

**Phase 2 — parked-task reconcile + fresh-task packet shapes**
6. **UC-23** — VC-2 hand-edit + watcher/Re-scan; restore the title exactly. Before UC-18.
7. **UC-08** — fresh vague task → quality-gate packet (reference shape for UC-27).
8. **UC-27** — fresh vague task, interrupt mid-run, manual re-run.
9. **UC-21** — fresh blocked task → decision packet + resolve via options.

**Phase 3 — org resources & runtimes (fresh tasks each)**
10. **UC-16** — backend parity FIRST here: its Codex leg is the F19-6 canary that decides
    the fallback for UC-12/17/19/22.
11. **UC-14** — MCP (requires `org_mcp_servers` count 0 — verify before, clean after).
12. **UC-15** — skills grant vs decoy (one run in flight per task — F19-15).
13. **UC-13** — KB + reviewer inheritance (reviewer profile must still have `kb: []`).

**Phase 4 — delivery / divergence / acceptance machinery (serialized; real GitHub writes)**
14. **UC-12** — rec-Apply impl→review (R15-3).
15. **UC-06** — PR closed out-of-band → recovery packet → reopen heals. Complete its
    cleanup before starting UC-07.
16. **UC-07** — PR merged out-of-band → divergence accept + DG-1 probe. Close the probe's
    leftover open PR in cleanup.
17. **UC-28** — foreign branch collision (R18-4). Cleanup deletes the foreign ref.
18. **UC-25** — post-review drift → accept merges FOR REAL (R17-1 disclosures).
19. **UC-19** — force-accept gates (409 on non-contained head; audited bypass).
20. **UC-20 Arm B** — the reachable "Completed — no changes" path (fresh task).
21. **UC-17** — full autonomy → merge pending → human `complete-merge`. NOTE: this step is
    live evidence for the NEW complete-merge zero-ceremony HIGH (task-side-panels.tsx:226) —
    record dialogCount at the click.

**Phase 5 — lifecycle tail + richest-state reads**
22. **UC-22** — archive + deleteBranch + schedule-cancel (its own fresh task).
23. **UC-18** — schedules on VC-2 (cancel arm, then FIRE arm — VC-2's last mutation of the
    pass), VC-1 terminal guard read-only, Arm D against UC-22's archived task.
24. **UC-24** — LAST: search/⌘K, notifications, badges. Needs UC-09's mention rows,
    UC-11's probe project, and UC-22's archived task makes the F19-9 rail-badge
    discrepancy observable live.

## Hard orderings (the non-negotiables)

- UC-11 → {UC-09, UC-10 (negative controls), UC-12, UC-24, UC-26}
- UC-20 Arm A → {UC-10, UC-09, UC-24} (any VC-5 byte writer)
- UC-23 → UC-18 (fire arm mutates VC-2)
- UC-22 → UC-18 Arm D; UC-22 → UC-24 (F19-9 live check)
- UC-09 → UC-24 (mention rows)
- UC-16 → {UC-12, UC-17, UC-19, UC-22} (F19-6 fallback decision)
- UC-06 cleanup → UC-07 start; UC-07 cleanup (close DG-1 probe PR) → UC-24
- Real-merge UCs (07, 25, 19, 17) strictly serialized, one at a time
- VC-5's packet stays OPEN through the whole pass; VC-2's packet stays open until UC-18's
  fire arm has run

## Findings still without a spec (implementation phase will need them)

- **All 11 new audit-round findings (this round's acceptance-gates ×4, rbac-capability ×3,
  ux-coherence ×4+2 low) have NO ledger IDs and NO specs** — assign F19-24+ and spec them.
  The two HIGHs first: complete-merge zero ceremony (task-side-panels.tsx:226) and
  forceAcceptCompletion missing terminal-fact guard (task-actions.server.ts:5274 — its spec
  MUST include deleting/inverting the pass-13 pin at acceptance-closed-pr.server.test.ts:469).
- **F19-3's existing spec (ledger-specs-1.md) is too narrow**: the new
  operator-actions.server.ts:1930 finding shows a `transition`-kind rec reaching acceptance —
  the confirm gate must key on the rec's TARGET (terminal stage), not `kind`.
- No spec: **F19-22** (NOTES has a fix sketch, not a spec), **F19-23**, **UX19-4**,
  **N19-1** (still unverified), **N19-5** (Q-V1 tests). F19-7..F19-20's spec is
  audit-workflow-result.json (per NOTES) — adequate.
