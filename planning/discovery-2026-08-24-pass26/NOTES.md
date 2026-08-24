# Pass 26 — discovery + live-test running notes (2026-08-24)

Baseline: main `b5b3128` (PR #219). Container image built 2026-08-23T19:40:50Z = current main
(includes ALL label-list PRs #213–#219). Live app at :5173 IS latest main — no rebuild needed.

Context: pass 25 (yesterday) shipped PR #205 (bug fixes) + PR #206 (four product slices: task
metadata, run-concurrency cap, audit export, Insights + 3 bug fixes). Then #207–#219 = a 13-PR UI
push building out the task-metadata inputs (Details panel, new-task fields, label chips + date
picker, then 6 PRs taming the label-list interaction). These last-24h features are the prime
bug-hunt territory.

Legend: ✅ verified sound · ⚠️ finding (bug/gap) · ❓ owner question · ⏳ in progress

---

## A. Task metadata (priority / labels / due date) — the churniest new surface

**A-VERDICT: server logic + UI SOLID.** Verified by code read + live:
- Schema: `coercePriority`, `normalizeTaskLabels` (trim/collapse/dedupe-CI/cap 12×32),
  `isValidDueDate` (rejects impossible dates) — all correct. `urgent` boolean is DERIVED from
  `priority === "urgent"` on BOTH write paths (create `task-actions.server.ts:495`, update `:713`),
  and the update guards `if (patch.priority !== undefined)` so editing labels/due-date alone does
  NOT clear urgent. No-op guard + per-axis validation + audit note all present.
- `mapTaskProjectionRow` carries priority/labels/dueDate; board card + hero render via ONE
  `app/ui/task-meta.tsx` (PriorityFlag/LabelChips/DueDatePill). Overdue is hydration-gated
  (avoids React #418). Label vocabulary query is project-scoped + archived-excluded + CI-dedup.
- LabelInput (6-PR component): live-tested — create "sec" → chip added, list stays open, buffer
  resets, full project vocab shown (`☑github ☑sec ☐codex ☐qa`). Deterministic blur + mousedown
  stopPropagation survive useDismiss. No correctness bug found.
- **LIVE COHERENCE ✅**: set VQ-3 priority high→urgent via Details panel → Save → timeline audit
  note ("priority → urgent · labels → github, sec") + toast → board card shows urgent/labels/overdue
  → **"Blocked or waiting" board filter now catches VQ-3** (it would NOT have when "high"). The
  derived-urgent → board-risk coherence holds end to end.

### ❓ Q26-1 — Task metadata is invisible to the operator AND the agents (human-only triage)
`taskContext()` (operator-actions.server.ts:2070-2086) returns only `{title, goal, stageName}`.
Grep confirms priority/labels/dueDate appear in NO run-prompt construction (operator or specialist).
So marking a task "urgent, due tomorrow" is a pure human board aid — the operator that recommends/
prioritizes and the delivering agent that executes never learn it. The WRITE path deliberately does
NOT re-invoke agents on a metadata edit (sound — you don't re-run on every label). But whether the
operator should FACTOR priority/due-date into its reasoning WHEN IT RUNS, and whether the agent
should be told a task is urgent, is unaddressed. **Owner call: is metadata intentionally human-only,
or should the operator/agent see it?** (Cheap to add to taskContext if wanted.)

---

## B. Insights dashboard (/insights, org-admin) — ✅ looks sound (subagent verifying SQL edges)
Live: 77 runs · $10.23 · 113.1K out (1.2K in · 9.0M cached) · 95% success (73 fin·3 err·1 stop) ·
39s avg · 841 turns · 30-day bar chart · by-backend (claude 74/$10.23, codex 3/$0.00) · by-run-kind
(operator 59/$6.28, primary 12/$2.57, reviewer 6/$1.38). Math internally consistent (74+3=77;
59+12+6=77; 6.28+2.57+1.38=10.23; 73/77≈95%). Codex $0.00 = pass25 quota-block (errored, no cost).
No per-project/per-model breakdown or cost-over-time (reasonable v1 scope). PENDING subagent: NULL-cost
SUM handling, empty-instance div-by-zero, timezone bucket boundaries, SSR/hydration date.

## C. Audit-log export (/org/settings/audit-export, org-admin) — ✅ SECURE + correct (live-verified)
- CSV: RFC-4180 (`\r\n`, `""`-escaped JSON details), `Content-Disposition: attachment;
  filename="viberr-audit-2026-08-24.csv"`, `text/csv`. JSON variant: clean array, nested details.
- **No secret leakage** across 1941 events / 52 action types: only "pat" hit is a PAT *record id*
  (`pat_…`, subjectKind github_pat) NOT the token; "password" only as `reason:"wrong_password"`;
  zero hits for secretAccessKey/accessKeyId/scrypt/$argon/bearer/the visible PAT fragment.
- **Formula-injection risk = 0** in real data (details start with `{`; actorLabel is email/system;
  taskKey/subjectId are controlled). Defense-in-depth neutralization (prefix `'` on =+-@) would be
  belt-and-suspenders; low priority given no vector in practice. (Subagent confirming.)
- ⚠️ WATCH: UI copy "Exports carry EVERY recorded fact" vs the 90-day retention sweep — verify it's
  honest that swept events are already gone (PG-2 point). Not yet confirmed.
- PENDING: admin-only enforcement server-side (I'm admin → 200; test non-admin in RBAC UC); S3
  SigV4 correctness (subagent).

## D. Run-concurrency cap (/org/settings) — ⏳ setting present ("unlimited · 0 runs live", Max at
once input, 0=unlimited). Live queue/drain test deferred to the QA project (needs runnable tasks;
real agent runs). Subagent auditing the gate (reserved-run bypass, drain-on-crash, off-by-one).

---

## LIVE USE-CASE LOG (pass 26, project Viberr QA 26 / slug viberr-qa-26 / key VVQX, repo akin-ozer/viberr, Balanced)

- **UC-N1 [✅] New-task WITH metadata** — created VVQX-1 with priority high, due Aug 29, labels qa+canary
  (comma-commit path). Persisted to task.md frontmatter (priority/dueDate/labels list) + board card
  renders all three. New-task modal date-picker (in-flow calendar) + label combobox both work.
- **UC-N2 [✅] Metadata edit + urgent→board-risk coherence** — VQ-3 Details panel: high→urgent Save →
  timeline audit note + toast → board "Blocked or waiting" filter now catches it. Label create ("sec")
  keeps list open, project-scoped vocab. (see section A)
- **UC-1 [✅] FULL LIFECYCLE → real PR #220 → MERGED.** VVQX-1: operator auto-scoped triage→ready→impl,
  created branch vvqx-1, engaged **Developer (Impl, Claude)** [correct agent selection], delivered
  **real PR #220** (+1/-0, `qa/pass26-canary.md` = EXACTLY the specified line, nothing else) → Viberr
  "Move to Review" recommendation (honest: "not the operator agent's judgement") → applied → operator
  engaged **Reviewer (verdict-capable)** → precise operator-derived review checklist → **verdict:
  approve** → validation healthy → operator "Accept completion" recommendation → **acceptance ceremony
  disclosed PR #220 · revision b17e27ed6519 · verdict validation healthy · "merging is one-way"** →
  confirmed → **real merge into main (69ba6c89a)** → Done. Traceability task→branch→commit→PR→merge
  perfect. Core loop INTACT after the 24h churn; metadata carried through the whole flow.
- **UC-RBAC-new-surfaces [✅ code-verified]** — /insights loader `requireRole("admin")` (insights.tsx:13),
  /org/settings/audit-export loader `requireRole("admin")` (:20), /org/settings action
  `requireRoleAuth("admin")` (:187, one gate covering set-concurrency + S3 + all intents). No RBAC hole
  in the 3 new admin surfaces. (Live non-admin spot-check pending.)
- **UC-agent-selection [✅]** — operator picked Developer (Implementation) for an impl goal; earlier VQ-2
  picked Codex Dev from a goal hint (pass25). Correct.
- **UC-reviewer-verdict [✅]** — reviewer engagement verdictCapable:true, developer verdictCapable:false;
  approve verdict flipped validation→healthy and gated acceptance. Correct.

