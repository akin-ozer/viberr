# Owner rulings — pass 3 (2026-07-12)

Asked with full background at the phase-1→2 boundary; all four answered.

## R-2026-07-12-1 · Q5 resolved: CLEAN TIERING
Viewer = strictly **read + comment** (no ownership take/release, no packet resolve, no create).
Contributor = viewer + **create tasks + take/release own ownership + owner-resolve of
non-completion packets** (the Q2 owner authority now effectively starts at contributor because
viewers can no longer own). Admin/maintainer unchanged.
Implementation notes: ownership row in matrix moves viewer→contributor+; setOwner/releaseOwner
role floor contributor; packet owner-resolve unchanged code-wise once ownership is contributor+
(but keep the membership check); shipped matrix, seeds, tests, profile "Your access" all updated.

## R-2026-07-12-2 · Agent eligible stages: WIRE IT
`stages`/`spanAll` become real: operator pickSpecialist/pickReviewer filter by the task's current
stage; assign/run specialist/reviewer validate stage eligibility server-side; get_task snapshot
carries eligibility so the operator reasons with it. UI already promises this — make it true.

## R-2026-07-12-3 · Review queue + Activity: MEMBERSHIP-GATE BOTH
`project.review.tsx` and `project.activity.tsx` require project membership (same
requireProjectMember treatment as policy/agents/settings/github). Board/task view stay app-wide
readable per PRD.

## R-2026-07-12-4 · S3: HONEST LABELING ONLY
No Codex enforcement work this pass. Capability modal + agents surface mark tool-denial
capabilities as "enforced on Claude · advisory on Codex". Nothing else.
