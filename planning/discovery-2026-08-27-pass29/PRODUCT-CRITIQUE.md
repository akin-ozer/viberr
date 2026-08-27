# Viberr — Product & Design Critique (Pass 29)

**Date:** 2026-08-27. **Scope:** a critical, evidence-grounded product-design review for the
owner, not another bug-hunting pass. Pass 29's own testing already found and fixed six
implementation defects (F2–F7, browser-capability pre-flight, an operator tool-description
drift, a stale packet coherence bug — see `IMPLEMENTATION.md`); those are resolved in this
worktree (`existsSync` checks confirmed present in `app/server/tasks/specialist-browser-mcp.server.ts:116,175`)
and are **not** re-litigated here.

**Method:** read the canonical intent documents (PRD, architecture, UX spec, `decisions.md`),
this pass's six domain-discovery docs (`DOC-product-intent.md`, `DOC-codebase-map.md`,
`DOC-agent-runtime.md`, `DOC-browser-capability.md`, `DOC-mcp-kb-skills.md`,
`DOC-rbac-delivery-events.md`), this pass's live-testing notes (`NOTES.md`,
`EXTENDED-COVERAGE.md`), and `README.md`, then spot-verified a dozen specific claims directly
against `app/` before writing anything below. Every item is marked with its evidence and a
judgment: **intended** (matches documented design), **gap** (a real absence), or **question**
(the code is unambiguous, but whether it's *right* is an owner call).

---

## 1. What Viberr is, and how it works

Viberr is a governed-delivery board where **AI agents are the workers and humans are the
governors**. A project wraps exactly one GitHub repository (`FR7/FR30`); a task is one
markdown file (`task.md`) that is simultaneously the ticket, the audit log, and the
agent-visible operating contract — frontmatter holds structured state, the body holds an
append-only, typed timeline. SQLite is a disposable read projection of those files (rebuilt
from them at boot and on every write); only account/session/secret/run-history state lives
solely in the database (`DOC-product-intent.md` §2.1, `DOC-codebase-map.md` §1.2).

Every active task has exactly one **operator** — a persistent LLM-driven coordinator, not a
scoring function — that reads a live snapshot of the task plus a real read-only repo clone
(`ruling 55/R19-1`) and decides, by reasoning over free-text `desc`/capability fields, which
**agent profile** to engage (`DOC-agent-runtime.md` §3.3). A profile is capability-gated
(`app/shared/capabilities.ts`, 60+ ids, mode `direct|recommend|human|off`) and backed by
either Claude or Codex. Exactly one engagement per task **delivers** (owns the workspace,
branch, and PR); every other engagement is **supporting**, and one can be a **required
reviewer** if it explicitly holds the verdict-report grant. Delivery (push + open PR) is
itself an *operator decision*, executed server-side — no agent ever pushes or opens a PR
directly (`ruling 21/R15-2`, confirmed live in `NOTES.md` UC9/UC18/UC19). Acceptance to `Done`
is human by default and gated on a healthy reviewer verdict on the exact delivered commit
(`ruling 20/R15-1`); merging a PR is **structurally** human-only at three independent layers —
capability policy, a non-optional `userId` on the merge function's type signature, and the
tool denylist (`DOC-rbac-delivery-events.md` §4.3) — with one narrow, audited exception where
a full-autonomy operator can move a task to `Done` without merging (PR stays "accepted, merge
pending" for a human to finish).

Three RBAC systems stay deliberately separate: org roles (admin/member), project roles
(viewer→contributor→maintainer→admin, one matrix in `app/shared/rbac.ts`), and agent
capability grants (per-profile, per-project). Knowledge bases, skills, and MCP servers are
org-level resources granted to profiles by directory/name and prompt-injected (KBs, and
skills on Codex) or natively mounted (skills on Claude); a real headless-browser capability
(`use-browser`, default off) lets a granted agent drive Playwright and post screenshots as
task evidence. The whole system is heavily event-sourced: the file is truth, the file watcher
and rebuilder keep SQLite converged, and a background poller reconciles GitHub PR state every
five minutes independent of anyone using the app.

This pass's live testing (20+ real use cases against real Claude runs, a real GitHub repo,
and a real merge — `EXTENDED-COVERAGE.md`) found the mechanics sound end-to-end: operator
agent-selection, KB/skill/MCP loading, delivery→review→accept→merge, reject→recovery→
branch-deletion, RBAC enforcement, and the browser capability all worked exactly as designed
on the first live pass, with only the six now-fixed defects. That maturity is the right frame
for this document — the interesting questions left are about calibration and completeness
of vision, not correctness.

---

## 2. Deliberate divergences from the PRD/UX-spec (not bugs)

These are places where the shipped app intentionally differs from the original planning
documents, and the *document* was amended to match the app. Listed so the owner sees the
accumulated drift in one place; none of these should be "fixed" back toward the original text.

| # | Divergence | Evidence | Why |
|---|---|---|---|
| 1 | "Primary specialist + consultant specialists" → uniform **engagements** model | `prd.md` FR14 amendment; `app/schemas/task-file.schema.ts` `engagementSchema` | Simpler, uniform data model (2026-07-19 "generic agents" rework) |
| 2 | Task-level repo override **deleted**, never built | `prd.md` FR7 amendment | Nothing ever wrote a task-level repo; the toggle enforced nothing |
| 3 | Agent-initiated task creation struck from FR11 | `prd.md` FR11 | Never implemented on any layer; subtask orchestration is post-MVP |
| 4 | **Project creation is self-serve**, not admin-gated | `prd.md` FR5 amendment; `app/routes/_index.tsx` | Deliberate — the creator becomes that project's admin; neighboring instance-maintenance actions on the same route *do* carry an org-admin refusal, by contrast |
| 5 | FR38 "any member" corrected to **contributor+** | `prd.md` FR38 | Ownership carries reviewer/acceptance authority; a viewer must not self-assign it |
| 6 | OAuth-first login was **never** the default | `architecture.md` lines 297-303 | Local email+password leads; OAuth is optional, whitelist-only |
| 7 | **Responsive "review-first mode" below 768px never built, retired** | `ux-design-specification.md` "One surface, reflowed" amendment; `ruling 66/R19-12` | Viberr ships one capability mode at every width — hiding a control on narrow viewport is now a *correctness* bug, not an a11y nice-to-have |
| 8 | **NFR1–4 numeric performance targets dropped** | `prd.md` NFR section header amendment (`ruling 63/R19-9`) | Never measured by any harness; a target nobody measures "is a claim, not a requirement" |
| 9 | "No linter, by decision" **reversed** — oxlint is now a required CI gate | `architecture.md`; `ruling 86/R21-3` | — |
| 10 | Design-system mock (`design/design-system.html`) is **not** the real token source | `ux-design-specification.md` Color/Typography sections, superseded notes | Colors (`#5b76fe` not steel-blue), radii (16/22px not 18/28px), fonts (Manrope/Noto Sans/JetBrains Mono not Roobert PRO) all diverged at port time |
| 11 | No spacing scale, no 12-column grid | `ux-design-specification.md` Spacing section, superseded note | Per-component rem values instead; a retrofit was explicitly rejected as not worth a tree-wide touch |
| 12 | `e2e` CI job runs the **production Docker image**, never a dev server | `architecture.md` line 965 | Owner policy since 2026-08-02 |
| 13 | Browser test matrix is **Chromium-only in practice** | `prd.md` Web App Requirements amendment; `architecture.md` lines 966 | Safari/Firefox declared as "support intent," never exercised automated or manual, in any pass — recorded as a gap, not silently claimed as covered |
| 14 | `attachments/` went from spec'd-never-built to fully real | `prd.md` FR9/FR17 amendments; `ruling 75/R19-19`, `96` | Shipped 2026-08-14/20, largest post-pass-19 capability the PRD hadn't caught up to |
| 15 | The **browser capability** itself was undocumented in canon until pass 22 | `prd.md` FR9 amendment | `use-browser`, default off, shipped under R19-19 |
| 16 | FR27's human-only `done` gained **one** narrow, audited exception (full-autonomy operator + explicit `completion-for-acceptance: direct`) | `prd.md` FR27 amendment (owner ruling Q1) | Still never confers the actual PR *merge*, which stays `ALWAYS_HUMAN` |
| 17 | FR39's "scheduled run pins backend/autonomy at schedule time" is **struck** | `prd.md` FR39 amendment (`ruling 94/R22-schedule`) | A fired scheduled run resolves the **live** deployed profile — same "surface shows, doesn't pick" rule as the manual run control |
| 18 | Two UX-spec components (Continuity Recovery Panel, board arrow-key traversal) were **ruled built** rather than allowed to lapse | `ux-design-specification.md`, `ruling 64/R19-10` | Confirmed present: `app/features/task-detail/continuity-recovery.tsx`; `app/features/board/board-page.tsx:2034-2035` (`ArrowLeft`/`ArrowRight` handling) |
| 19 | `docs/architecture/decisions.md` itself is a **recovery artifact** | `decisions.md` lines 8-14 | The original `CONVENTIONS.md` was deleted while ~26 code comments still cited it; reconstructed with ruling numbers preserved |
| 20 | Standard 5-stage workflow is the **only** creation template; Lightweight 3-stage deleted | `ruling 15` | — |

---

## 3. Genuine gaps / missing features

Ranked by impact. Several areas turned out to be **complete and well-designed** — called out
at the end of this section rather than papered over.

### 3.1 High impact — the product measures nothing against its own PRD success criteria

The PRD's "Measurable outcomes" section (`prd.md` lines 63-69) defines five concrete targets:
≥90% of active tasks with an unambiguous owner/waiting-state/latest-packet, ≥90% task-key↔
branch↔PR traceability, faster execution-to-review-ready time than the team's prior workflow,
fast time-to-human-decision on blocked tasks, and stable readability on long-running tasks.
**None of these is instrumented anywhere in the product.** The one analytics surface,
`/insights` (`app/server/insights/insights-query.server.ts`), is a pure run-execution
dashboard — cost, tokens, duration, success rate, breakdowns by backend/kind/project/model
(confirmed by reading the full `InsightsSummary` shape, lines 16-56) — with zero governance
metrics: no packet time-to-resolution, no "% tasks with a clear owner," no traceability audit.
A team adopting Viberr specifically to prove the PRD's own value thesis has no built-in way to
check whether it's happening. This is squarely inside what the PRD calls for and squarely
absent from the build. **Verdict: gap**, not a deliberate cut — nothing in `decisions.md` or
the README discusses dropping these metrics; NFR1-4's removal (divergence #8) was about
*unmeasured latency numbers*, a different question from *governance-outcome reporting* not
existing at all.

### 3.2 Medium-high impact — quota/rate-limit exhaustion is purely reactive

`claude-runtime.server.ts:513-520` classifies a failed run's error text into a `"quota"` kind
*after the run has already failed*, surfaced to a human via a blocked "Work stalled" recovery
packet. There is no proactive signal anywhere in the product — not on `/insights`, not on the
Agents page, not on the task page — of approaching quota exhaustion. This pass's own live
testing hit it directly: `NOTES.md` line 70 records "operator run logged `seven_day
utilization 0.91`... Be economical with real Claude runs," visible only by a human reading raw
run-log JSON, not through any UI affordance. For a product whose operator can autonomously
fire many runs per human action (see design-question #1 below), this is a real operational
blind spot: a small team can silently burn most of a 7-day allowance without any dashboard
telling them until a run fails mid-task. **Verdict: gap.**

### 3.3 Medium impact — the browser capability has no on-ramp

`use-browser` ships **default off** on every capability the catalog defines
(`app/shared/capabilities.ts:111`), and **no seeded or built-in profile grants it**
(confirmed: no `use-browser` reference anywhere in `app/server/seed/agent-catalog.server.ts`).
A team must know the capability exists, open the profile editor, find it inside the
Collaboration accordion, and grant it (plus the auto-coupled web-egress grant) before ever
using a feature the PRD calls one of the two largest post-pass-19 additions (divergence #14).
Pass 29's own tester had to hand-author a "Web QA" profile from scratch to exercise it
(`NOTES.md` line 32). Nothing in the product surfaces "you have a real browser available"
unprompted. **Verdict: gap** in discoverability, not mechanics — the underlying capability is
now solid (post F2/F5 fixes). See design-question #3 for the calibration question behind it.

### 3.4 Medium impact — resource-rename integrity is best-effort with no visible backstop

Renaming or deleting a KB/skill/MCP server rewrites every referencing profile/project file
(`app/server/org/resource-references.server.ts`), but a single malformed frontmatter file at
rename time is silently skipped with only a `logger.warn`
(`resource-references.server.ts:122-129, 175-182`) — no audit row, no admin-visible flag, no
follow-up reconciliation. `DOC-mcp-kb-skills.md` §6.1 flags this as unverified-but-plausible;
I did not reproduce it live (out of scope for this document), but the code path is real and
the failure mode — a profile silently keeps a stale grant name forever — is exactly the class
of "silent-resource" bug this project has hunted before (the KB display-name-vs-dir bug,
P13-KM-01). **Verdict: gap** — worth a boot-time or save-time integrity sweep rather than
per-caller best-effort.

### 3.5 Lower impact, flagged for completeness

- **Skill-mount residual**: a finished run's mounted skill folder is never cleaned up from a
  shared task workspace (`skill-mount.server.ts:84-95`, explicitly "not nothing" in the code's
  own comment) — a co-engaged agent on the same task could, in principle, see a departed
  specialist's stale skill content. Not reproduced live this pass. **Verdict: minor gap.**
- **`claudeMdExcludes` is an admittedly unverified mitigation** (`claude-runtime.server.ts:317-334`):
  any run with at least one skill grant opens `settingSources: ['project']`, which is also the
  channel that loads a checked-out repo's own `CLAUDE.md` as system-prompt-tier instruction.
  The code's own comment says to "treat the ingress as OPEN until someone reads a run's system
  prompt and confirms otherwise." Given this project's own stated scope ("skip security
  deep-dives, just build features" — prior session memory), I'm not treating this as an
  incident, but it is a genuinely open question the code itself has not closed, not a settled
  design choice. **Verdict: open question**, worth a session confirming what actually lands
  in the prompt, next time security attention is in scope.
- **No task-level template/boilerplate library.** Confirmed absent (`DOC-mcp-kb-skills.md`
  §4 — only agent-profile templates exist, no task-description or checklist templates). Not
  promised anywhere in the PRD, so this is a nice-to-have observation, not a real gap.

### 3.6 Areas that are genuinely complete — say so

- **RBAC** (three-axis model, single-source matrices, org-admin override always audited) is
  thorough and consistently enforced; live RBAC testing this pass (`NOTES.md` UC6) found
  exactly the behavior the code promises.
- **Event-sourcing / projection integrity** (torn-write protection via hash-written-last,
  CRLF normalization, same-timestamp ordering, boot-time crash recovery with a crash-loop
  backstop) is unusually rigorous for a project this size — this is not a corner that was cut.
- **Acceptance/merge enforcement** is triple-redundant by design (capability policy + a
  non-optional type parameter + tool denylist) — genuinely hard to accidentally regress.
- **The browser capability**, post pass-29 fixes, is now end-to-end solid: real chromium,
  real screenshot→attachment→evidence pipeline, member-only serving with a locked-down CSP,
  disclosed Codex asymmetry, health signal, and a pinned persona contract test.
- **KB/skill/MCP grant mechanics** (shared budgets, honest "unresolved" disclosure rather
  than silent drops, reserved-name protection, credential sealing/rotation) are consistently
  built to the same "never silent" standard across all three resource types.

---

## 4. UX / product improvement opportunities

Polish, coherence, and workflow-friction items — not correctness bugs (those are tracked as
F-series findings elsewhere). Marked **clear improvement** vs **matter of taste**.

1. **`/insights` is org-admin-only** (`app/routes/insights.tsx:9-13`, explicit in the code
   comment: "run cost and token totals across every project are an instance-owner view"). A
   project maintainer running a real delivery workload has no visibility into their own
   project's agent spend without asking an org admin. *Matter of taste* — could plausibly be
   intentional (see design-question #5), but a project-scoped read-only slice would be low-risk
   to add if the answer is "no reason to withhold it."

2. **Capability-matrix label overload** was investigated this pass and explicitly ruled
   not-a-bug (`NOTES.md` "RESOLVED / verified-by-design"): a profile's own `mode: human` grant
   on a non-`ALWAYS_HUMAN` capability renders with the identical red "Reserved for humans"
   treatment as the true three-capability reserved trio. Two agents that both simply lack a
   grant can show different labels ("Not granted" vs "Reserved for humans") depending on which
   mode was used to withhold it. The underlying behavior is correct and intended per-profile
   semantics; the **shared visual treatment across two different meanings** is still a
   legibility cost for anyone reading the matrix cold. *Clear improvement opportunity*,
   independent of the "don't fix the semantics" ruling already made — e.g., a distinct
   secondary label or tooltip ("this profile defers to a human," vs. "no agent can ever do
   this") would remove the ambiguity without touching the underlying grant model.

3. **Session-export for native-runtime debugging (FR23)** is satisfied via a download-a-
   bash-installer-and-run-it-locally flow (`/resources/session-export`,
   `DOC-codebase-map.md` route table), rather than any in-app deep-dive view. This is a
   reasonable MVP shape for a feature aimed at the "Murat" troubleshooter persona, but it's a
   context switch (leave the browser, run a script, open a separate terminal-based session) for
   what the UX spec frames as a debugging affordance that should stay connected to the task's
   trust story. *Matter of taste* — an in-app read-only transcript viewer would be strictly
   more polished but is real, non-trivial work for a persona this product explicitly treats as
   secondary.

4. **Codex/Claude asymmetries are disclosed, but scattered.** The persona text, the
   capability-matrix modal's asymmetry bullet, and (since pass 29's F4) an inline note on the
   profile editor's browser row each disclose a different piece of the Claude/Codex gap
   (tool-denylist enforcement, skill mounting, MCP credentials, tool-name casing, screenshot
   visibility — full list in `DOC-agent-runtime.md` §2.3's table). An admin deciding whether to
   deploy a given profile on Codex has to have read several different surfaces to get the full
   picture; there's no single "what's different on Codex" reference reachable from the profile
   editor itself. *Clear improvement opportunity* — a consolidated "Codex differences" info
   panel (even just re-rendering the existing table) linked from wherever a Codex backend is
   selected would consolidate disclosure that's currently fragmented by design intent (each
   disclosure was added at the point it mattered) rather than by a documentation plan.

5. **The notification catalog is a closed five-kind enum** (`packet | approval | mention |
   quality | policy`, `app/shared/mapping/notification.server.ts:17-24`) with no "run
   finished" or "run failed" kind — a maintainer who queued several runs and stepped away gets
   nothing async unless the run's *outcome* also happens to produce one of the five kinds.
   In practice this mostly works out (failures escalate to packets, verdicts are approvals),
   but it is a deliberate anti-noise design choice with a real edge: a routine specialist run
   that finishes cleanly with no packet, no mention, and no quality flag produces zero
   notification to anyone not already on the task page. *Matter of taste*, consistent with the
   product's stated "calm over chatter" principle (`ux-design-specification.md` Experience
   Principles) — flagged as design-question #10 rather than asserted as wrong.

6. **Attachments have no retention or size governance** (`task-attachments.server.ts:8-25`,
   explicit deliberate simplicity per the code comment) — a browser-capable agent running
   repeatedly on the same task can accumulate unbounded screenshots with only a 100-item
   *display* cap hiding the growth, no total-directory-size limit, and no admin-visible growth
   signal. *Clear improvement opportunity* if browser-capability usage scales up (see
   design-question #7) — low cost to add a soft warning even without full retention machinery.

---

## 5. Design-choice questions for the owner

Ranked by how much they'd change behavior or positioning if answered differently. Each states
the current behavior with evidence, the case for it being intended, the case for it not being,
and the specific decision needed.

### Q1. Is the operator's re-invocation cadence calibrated for real usage economics?

**Current behavior:** the operator re-runs on nine distinct trigger kinds — `create`,
`transition`, `agent-reply`, `goal-updated`, `pr-diverged`, `delivered`, `packet-resolved`,
`scheduled`, `manual` (`DOC-agent-runtime.md` §3.1 trigger table, `operator-run.server.ts:1135,
161-170`) — meaning nearly every human action *and* every specialist-run completion spends a
fresh operator LLM call. **Case for intended:** each trigger is individually well-justified in
the code comments ("COORDINATE"/"REACT"/"RE-CHECK"), concurrent triggers already coalesce, and
the whole point of the product is that the operator stays continuously present. **Case for a
gap/miscalibration:** this pass's own live testing hit a real Claude 7-day utilization of 0.91
during a single QA session on one small project (`NOTES.md` line 70) — a small team running
several concurrent projects at this cadence could plausibly exhaust a subscription-tier budget
well before doing much real delivery work. **Decision needed:** is per-trigger operator
proactivity a deliberate, accepted cost of the product's value proposition, or should some
triggers (e.g., `agent-reply` on a routine, uneventful specialist finish) become lazier —
batched, debounced, or downgraded to a cheaper "did anything change" check before spending a
full operator run?

### Q2. Is Codex meant to be a true peer backend, or a disclosed second-tier option?

**Current behavior:** since R22 removed Codex's OS-level sandbox, the *entire* repo-write
capability family is enforced on Claude via a real tool denylist but is **advisory only** on
Codex (`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, `capabilities.ts:270-283`); Codex also has no
native skill mount (prompt-injection only), never receives MCP credentials (argv-visibility
risk), and derives different MCP tool-call names (hyphen vs. underscore) from the same grant.
**Case for intended:** every one of these is individually documented as a deliberate,
disclosed trade-off, and the product's real enforcement boundary is explicitly stated to be
the server-owned delivery gate (push/PR/merge/Done are server actions no agent tool reaches),
not either backend's sandbox. **Case for a gap:** the PRD and README list "Codex / Claude Code
backends" as a symmetric V1 requirement (`FR19`) without qualification, and none of these
asymmetries are visible to a project admin choosing a backend *before* they open the
capability-matrix modal or read a persona note. **Decision needed:** should product-facing
copy (not just code comments and an expandable modal) actively frame Codex as "reduced
enforcement, same governance gate," e.g., a persistent badge on any Codex-backed profile
holding `execute-code-or-write-repo`? Right now the honesty exists, but only for someone who
goes looking.

### Q3. Should a browser-capable example profile ship in the seed catalog?

**Current behavior:** `use-browser` defaults off and no seeded profile grants it (§3.3 above).
**Case for intended:** the capability is powerful (real code execution against a live browser)
and default-off-with-explicit-grant matches the product's general "withheld unless granted"
posture for anything network- or execution-adjacent. **Case for a gap:** a team is unlikely to
discover the capability exists at all without reading documentation, since nothing in the
product's own UI proactively surfaces it — this pass's tester had to hand-build a profile to
exercise a feature the PRD calls one of its two largest recent additions. **Decision needed:**
ship a seeded, off-by-default "Web QA" style template (analogous to the seeded Developer/
Reviewer templates) that an admin can deploy with one click, versus leaving discovery to
documentation/support.

### Q4. Is "Done, merge pending" an acceptable terminal-state semantic, or does it need a distinct label?

**Current behavior:** under full autonomy with an explicit grant, the operator can move a task
to the `Done` stage while the PR merge is still pending a human (`ruling 40/R16-6`) — the same
stage label ("Done") means two different things depending on who accepted, disclosed via UI
copy and a background nag poller. **Case for intended:** this is an explicit, carefully-audited
owner ruling (Q1) with real disclosure at every touchpoint the discovery docs checked. **Case
for reconsidering:** a stage *label* that means two different real-world states (fully merged
vs. merge-pending) is exactly the kind of ambiguity the PRD's own success criteria (§3.1 above)
are trying to eliminate — "unambiguous... waiting state" is a named goal. **Decision needed:**
is the current disclosure (copy + poller nag) sufficient, or does the board/task chrome need a
visually distinct state (not just a caption) for "Done, merge pending" vs. "Done, merged"?

### Q5. Should project maintainers see their own project's agent-run costs?

**Current behavior:** `/insights` is gated to org admins only, explicitly by design comment
(§4 item 1). **Case for intended:** cost/token totals aggregate *across every project*, which
is legitimately an instance-owner concern the org admin should control. **Case for
reconsidering:** a maintainer actively running a real delivery workload on their own project
has no way to see whether they're burning disproportionate spend, without asking an admin —
friction for exactly the persona (Arda, the day-to-day supervisor) the product is built
around. **Decision needed:** keep instance-wide aggregation admin-only, but add a
project-scoped read-only cost view for maintainers of that project — or confirm cost
visibility should stay a leadership-only concern by design.

### Q6. Should Viberr surface backend quota/rate-limit health proactively?

**Current behavior:** quota exhaustion is detected only after a run fails, by regexing the
provider's own error text (§3.2 above). **Case for intended:** Viberr deliberately avoids
polling providers for usage data outside of an actual run (keeping "no paid call for
availability detection" as a stated principle — `runtime-registry.server.ts` per
`DOC-codebase-map.md`), and providers may not expose a clean usage API to poll safely anyway.
**Case for reconsidering:** the *symptom* the code already captures (a matched "quota"/"usage
limit" string, `claude-runtime.server.ts:513`) could be surfaced as a coarse "recently near/at
quota" flag on the Agents page or Insights, purely from run history already in SQLite, with no
new provider calls at all. **Decision needed:** is even a passive, run-history-derived
quota-health indicator worth adding, or is per-run reactive handling (retry-other-backend,
recovery packets) considered sufficient?

### Q7. Is unbounded attachment growth an accepted V1 risk?

**Current behavior:** no retention or size cap beyond a 100-item *display* cap and a 50MB
per-file serve limit (§4 item 6). **Case for intended:** explicitly stated as a deliberate
simplicity trade-off in the code's own comments — "no retention machinery." **Case for
reconsidering:** the browser capability actively encourages repeated screenshot evidence per
run, and there's no admin-visible signal before a data root fills up. **Decision needed:**
accept the current no-limit posture as fine for expected V1 scale, or add a lightweight
per-task or per-project soft cap with a disclosed warning (not full retention/archival
machinery) ahead of wider browser-capability rollout.

### Q8. Is the Viewer role's ceiling (comment only, no visibility into credentials) exactly where it should sit?

**Current behavior:** a project Viewer can see the board/tasks (once a member) and comment
(app-wide `comment` action), but cannot see the GitHub credential card at all (withdrawn, not
disabled — `ruling 65/R19-11`) and cannot take any other action. **Case for intended:**
consistent with least-privilege and confirmed correct in this pass's live RBAC testing
(`NOTES.md` UC6 — a real viewer got 403 on `owner-take`, 200 on `comment`, and the UI rendered
no mutating controls at all). **Case for reconsidering:** none identified — this is one of the
best-tested, most self-consistent parts of the product. **Decision needed:** none — recorded
here as confirmation the model is working as designed, not as an open question. (Included to
show the review covered RBAC thoroughly rather than skip a well-built area.)

### Q9. Should the MCP admin UI warn at grant time that a credentialed server degrades on Codex?

**Current behavior:** a credentialed org MCP server authenticates on Claude but connects
**unauthenticated** on any Codex-backed profile holding the same grant (deliberate, to avoid
an argv-visible secret leak — `codex-runtime.server.ts:160-168`), disclosed only in the
*agent's own persona text*, not in the admin-facing grant UI (`DOC-mcp-kb-skills.md` suspected
issue #5). **Case for intended:** the asymmetry is a hard technical constraint (Codex's SDK
serializes MCP config via visible argv), not a product choice to hide anything — and the agent
itself is told, so it won't confabulate results. **Case for reconsidering:** the *admin*
granting the server to a Codex profile is the one who should decide whether a
permanently-degraded (possibly non-functional) tool for that backend is acceptable, and
currently has no signal at grant time. **Decision needed:** add a save-time warning on the
grant UI when a credentialed MCP server is attached to a Codex-backend profile, mirroring the
pattern already used for the browser/egress coupling repair notice.

### Q10. Is "no async notification for a routine run finishing" the right default?

**Current behavior:** the notification catalog has no "run finished"/"run failed" kind (§4
item 5) — completion surfaces live via SSE to whoever has the task page open, and nobody else
unless the outcome also produces a packet/quality/mention/approval event. **Case for
intended:** directly matches the stated "calm over chatter" experience principle
(`ux-design-specification.md`) and avoids exactly the noise anti-pattern the UX spec calls
out. **Case for reconsidering:** a maintainer who queues several long specialist runs across
different tasks and steps away has no digest or "your queued work finished" signal at all,
only per-task live presence. **Decision needed:** keep the current all-or-nothing model (SSE
while watching, governance-event notifications otherwise), or add a narrowly-scoped, opt-in
"my queued runs finished" digest that doesn't reopen the general noise problem the five-kind
catalog was designed to avoid.

---

## 6. Scope boundaries the owner already declared

Pulled from `README.md`'s "Known gaps" section and `decisions.md`/PRD rulings that explicitly
bound scope. Nothing in this document re-proposes any of these — they are settled.

**From `README.md` "Known gaps (V1 release notes)" (lines 230-257):**
- No mailer — notifications are in-app only; whitelisted users get a one-time password handed
  over by an admin, not an email.
- Org-level audit **console** — org-scoped audit rows (user admin, connections, auth) are
  recorded but have no UI; only project-scoped audit is browsable (Activity → Audit logs).
- Audit rows expire at 90 days with **no export** (Phase 2); run log lines expire at 30 days;
  notifications trim to the newest 500/user. None of the three windows is env-configurable.
- `provenance` is the **one table with no retention** — grows unboundedly by design; pruned by
  hand per the runbook.
- **No cleartext-transport guard in the app itself** — TLS termination is the deployment's job.
- Notifications page caps at the newest 200 rows, no pagination.
- Fine-grained PAT validation is **partly probe-based** — some scopes report "assumed" until
  first use.

**From the PRD's explicit "Growth (post-MVP)" / "Phase 2" / "Phase 3" scoping (`prd.md` lines
75, 191-193):** richer agent-profile templates beyond the current org/project two-tier model;
stronger policy tooling beyond the current Policy page; deeper review/validation workflows
beyond the current reviewer-verdict model; task-graph and subtask orchestration (agents cannot
create tasks — `FR11` — and there is no subtask concept anywhere in the schema); audit export;
broader multi-team/org-scale rollout; additional execution backends beyond Claude/Codex.

**From `decisions.md` rulings that closed a scope question rather than opening one:**
- Lightweight 3-stage workflow template **deleted** — Standard 5-stage is the only creation
  template (`ruling 15`).
- No spacing scale / no 12-column grid retrofit (`ux-design-specification.md` superseded note)
  — explicitly rejected as not worth a tree-wide touch for no user-visible gain.
- Responsive "review-first mode" below 768px **retired**, not built — one capability mode at
  every width is the permanent design, not a placeholder (`ruling 66/R19-12`).
- Browser test matrix is Chromium-only in *practice* though declared broader in the PRD — an
  acknowledged gap the owner has chosen to carry rather than close (divergence #13 above);
  re-raising "test Safari/Firefox" is a known, already-logged item, not new information.
- `tweaks-panel.jsx` was explicitly not ported (dev harness only) — `ruling 8`.
- NFR1–4 numeric performance targets are gone from canon on principle, not oversight — any
  future latency budget "arrives in the same change as the harness that measures it, never
  before it" (`ruling 63/R19-9`).
