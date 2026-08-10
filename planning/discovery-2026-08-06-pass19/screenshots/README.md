# Pass-19 page-by-page screenshot record

Captured 2026-08-10 against the live dev server (Playwright, authenticated as
arda, dark 1440×900 unless noted, full-page JPEG). This is the persisted
artifact of the UI tours in `../UI-TOUR.md` and `../UI-CRITIQUE-CURRENT.md`,
taken AFTER the pass-19 implementation (PR #157 tree + rulings 70/71).

| # | File | Surface | What it evidences |
|---|------|---------|-------------------|
| 01 | `01-login.jpg` | /login | Local-first login (R17-4) |
| 02 | `02-home.jpg` | / | Greeting + decisions pill, 3 project cards, settings summary |
| 03 | `03-notifications.jpg` | /notifications | Inbox; badge hygiene per R19-15 |
| 04 | `04-profile.jpg` | /profile | Profile + GitHub handle linking (feeds R19-B) |
| 05 | `05-org-connections.jpg` | /org/settings | PAT connection, masked secret |
| 06 | `06-org-users.jpg` | /org/settings | Org roles (2 admins · 1 member) |
| 07 | `07-org-resources.jpg` | /org/settings | KBs w/ freshness, MCPs w/ honest staleness chips, skills incl. the `kubernetes-rollback` decoy (R18-5 proof surface) |
| 08 | `08-board-viberr-core.jpg` | board | 12 tasks; per-lane "+" on the ENTRY lane only (R19-14) |
| 09 | `09-review-queue.jpg` | review | Acceptance-readiness split (UX19-3 one-gate column) |
| 10 | `10-agents.jpg` | agents | 3-tier capability policy; per-agent resource isolation |
| 11 | `11-policy.jpg` | policy | Human RBAC matrix vs agent capability — two surfaces |
| 12 | `12-github.jpg` | github | 9 task-linked PRs (in review/merged/closed); "merging stays reserved for humans" |
| 13 | `13-activity.jpg` | activity | Stream + audit (R19-7 compaction, R19-A clamp, force-accept rows) |
| 14 | `14-project-settings.jpg` | settings | Stage editor: Remove Triage/Done disabled with reasons |
| 15 | `15-task-VC-7-recovery-packet.jpg` | task detail | Closed-PR recovery packet (R16-3), GitHub rail, honest "Acceptance is closed" note |
| 16 | `16-task-VC-2-triage-packet.jpg` | task detail | Triage-gate packet (FR15), D18 continuity surface host |
| 17 | `17-board-empty-ops-sandbox.jpg` | board (empty) | First-run empty states; no "+" below entry, none on Done |
| 18 | `18-board-light-mode.jpg` | board, light | Both-theme contrast gate (R19-12) holds live |
| 19 | `19-board-mobile-375.jpg` | board, 375px | Responsive stack + h-scroll lanes |

Note: the bell badge VISIBLY DROPS across the sequence (27 → 19 by capture 15)
because the capture session's own page views trigger R19-15 auto-read — the
ruling demonstrating itself inside the record.
