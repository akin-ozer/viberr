# Pass 22 — owner questions queue (2026-08-21)

To be asked as a consolidated batch at the discovery→implementation boundary (the user is
away during discovery; none of these block live testing — they shape what/whether to implement).
Full background for Q1–Q8 lives in [PRD-ALIGNMENT.md](PRD-ALIGNMENT.md#owner-questions).

## From PRD alignment (Q1–Q8, background there)
1. Promote browser→egress coupling (PR #176) to a numbered ruling + amend ruling 75(a)? Confirm the auto-flip is intended on all 3 save paths.
2. Schedule surface keeps per-run backend/autonomy pickers while R21-9 removed them from the operator card — intended (FR39 scope note) or coherence gap to close?
3. Tighten run-operator route so it ignores backend/autonomy form overrides no UI sends (backend currently unclamped)?
4. AD-1: read-only Codex evidence runs get "Posting files" persona the sandbox blocks — widen sandbox (A) or suppress the persona for read-only (B)?
5. Held UX gaps D7/D10/D11/D12 (packet severity fields, continuity escalated/paused states, execution-truth continuity, skeleton loaders): build or retire-with-amendment?
6. FR38 viewer-floor: confirm taking ownership floors at contributor (code) vs "any member" (doc)?
7. Make attachments + browser first-class PRD requirements (amend FR9/FR17 vs new FR40)?
8. Promote the six commit-only owner rulings from #176–186 now, or batch — and which count as law vs taste (#180/#182/#186)?

## From live findings (this session)
9. [F22-08] Codex usage-limit failures are misclassified as auth/config and the retry date is dropped — the real reason is in the `turn.failed` stream event viberr already receives. Fix confirmed cheap; this is the "Codex and Claude behave the same from viberr's eye" gap. (Implement — likely no owner decision needed, just confirm priority.)
10. [F22-10] Reconcile poller adopts a name-colliding stale remote branch as the task's execution branch (showed prior-session's +214/−16 as this task's). Add a display-layer collision guard? (Implement — confirm desired behavior: hide vs collision-state.)
11. [F22-09] No backend fallback when the first/only pinned backend is down (quota/outage) — the run just blocks. Should a hard backend OUTAGE (not a task failure) fall through to another listed backend, or stay a human packet? (Owner decision — the profile now pins exactly one backend, so this may be moot by design.)

## Notes on autonomy for the batch
- Q6, Q9, Q10 are near-certain implements (doc/code clearly wrong); I'll propose fixes and only need a yes/no.
- Q1, Q2, Q4, Q5, Q8, Q11 are genuine product/canon decisions — hold for owner.
- Q3, Q7 are shaping choices with an obvious default (tighten / amend in place) — I'll recommend and proceed unless overridden.
</content>
