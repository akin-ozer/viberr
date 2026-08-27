# Viberr — Canonical Product Intent Reference

Distilled for an agent with no prior context, ahead of a discovery/inspection pass.
Sources (read in full to produce this doc):

- `planning/planning-artifacts/prd.md` (298 lines) — the PRD, canon for FRs/NFRs
- `planning/planning-artifacts/architecture.md` (1185 lines) — architecture, **wins on conflict** with `docs/architecture/decisions.md` (decisions.md line 5)
- `planning/planning-artifacts/ux-design-specification.md` (985 lines) — UX spec
- `docs/architecture/decisions.md` (1286 lines) — binding conventions + numbered orchestrator rulings (R-series) code comments cite
- `README.md`, `CONTRIBUTING.md` — top-level product/dev framing

**Reading rule inherited from these docs themselves:** several of the above documents contain
inline "amendment"/"superseded" notes where the shipped app diverged from the original spec and
the *document* was corrected to match the app, not the other way round (architecture.md line
1057-1061: "a divergence is a doc bug to fix, not scope to build"). Where this reference cites a
requirement, it cites the amended/current text, and section 6 below inventories the divergences
explicitly since those are deliberate product decisions, not gaps.

---

## 1. What Viberr is

**Elevator pitch** (README.md:1-11, PRD executive summary lines 40-46): Viberr is a multi-user
web application for **governed AI software delivery** — a Kanban-style board where persistent
AI coding agents (Claude Code, OpenAI Codex) do the actual delivery work against real GitHub
repositories, a dedicated **operator agent** triages and coordinates each task, and human
engineers govern flow, review, and acceptance rather than writing the code themselves.

**Core value prop / differentiator** (PRD lines 40, 46, 138-145): Viberr is **agent-native in
both action and responsibility**. In Jira-like tools, humans are the default workers and AI
helps at the edges; in Viberr, **agents own task execution** while engineers govern movement,
approvals, and quality boundaries. The task itself — a single canonical markdown file — is the
durable operating contract between humans, persistent agent threads, and GitHub execution,
replacing scattered chats, branches, and status labels with one readable record.

**Target user** (PRD lines 81-88, UX spec lines 43-47): Small AI-forward engineering teams
already using Codex/Claude Code ad hoc. Primary persona "Arda" — a senior engineer/tech lead
supervising several persistent agent threads across active tasks. Secondary personas: "Elif"
(admin/workflow owner who configures projects, RBAC, and agent capability policy) and "Murat"
(troubleshooter who steps in on runtime-continuity failures).

**Defining experience** (UX spec lines 67-73): *governed supervision* of live agent-driven
delivery — scan the board, identify what needs attention, open a task, understand current
state immediately, review the latest decision packet, take the next human action. Not a
passive tracker; a "calm operations console."

**What Viberr is emphatically NOT**: a GitHub-review replacement, a generic AI assistant, or
"kanban with AI badges" (PRD lines 138, 195 in UX spec — "generic kanban sameness" is a named
anti-pattern).

**Stack** (README.md:23-27): React Router 8 (SSR/framework mode) · Node ≥26 · TypeScript 7 ·
`node:sqlite` (WAL) · Zod v4 · SSE (no websockets) · ported `viberr.css` design system (no
Tailwind). Agent runtimes: Claude Agent SDK + Codex SDK. Single-node Docker deployment,
file-authoritative business state (see §2).

---

## 2. Core domain model & entities

### 2.1 The file-authoritative principle (architecture.md lines 34, 46, 226, 260-262)

**Files are the ONLY authoritative business state.** Projects and tasks live as markdown
(frontmatter + body) under a runtime data root; SQLite is a **derived projection/interpretation
store only** (users, sessions, encrypted secrets, audit, run history — "app management" state —
are the one exception: they live ONLY in SQLite, nowhere in the markdown; see architecture.md
line 828). Humans and agents may edit files directly; the app observes, parses tolerantly,
derives readiness, and projects a UI — it never gatekeeps through an app-controlled write path
for interpretation purposes, though governed *mutations* go through dedicated writer modules
(decisions.md lines 81-83).

Data root layout (architecture.md lines 797-829):
```
projects/<slug>/project.md
projects/<slug>/tasks/<KEY>/task.md
projects/<slug>/tasks/<KEY>/workspace/   # git clone, disposable, NOT canonical
projects/<slug>/tasks/<KEY>/attachments/ # agent-posted evidence files, member-only
projects/<slug>/.repo-mirror/            # bare mirror cache for clones
agents/profiles/                         # org-level agent profile templates
runtimes/{claude-home,codex-home}/
kb/<dir>/   skills/<slug>/
state/{projection.sqlite, writer.lock}
```

### 2.2 Entities

- **Project** (`project.md`): one GitHub repository per project (FR7, FR30 — no per-task
  override); defines workflow stages/transitions, RBAC, agent capability policy, repo default.
- **Task** (`task.md`, canonical operating record — FR12): identity, goal, state, execution
  context, timeline, decisions, execution references, in **one readable file**. Moves through
  project-defined workflow **stages** under governed transition rules (FR13). Task-key branch
  naming (`vib-142` etc.) ties GitHub state back to the task.
- **Board / stages**: per-project list in `project.md`, Standard 5-stage template is the only
  creation template (Lightweight/3-stage preset was deleted — ruling 15/decisions.md:207-211).
  New tasks are created at the **entry stage only** (ruling 70/R19-14).
- **Engagements** (the "generic agents" model, replacing the old "primary specialist / consultant
  specialist" vocabulary — FR14, PRD lines 226): a task carries one uniform `engagements[]` list.
  Exactly one engagement has `delivers: true` — the **delivering engagement**, sole owner of the
  workspace/branch/PR (single-writer invariant). Every other engagement is **supporting**,
  read-only by default. A supporting engagement with `verdictCapable: true` (from an explicit
  `report-validation-verdict: direct` grant) is a **required reviewer** whose approval acceptance
  waits on. Schema: `app/schemas/task-file.schema.ts`; see `docs/architecture/file-formats.md` §2.
- **Operator agent** (FR18, FR20, FR26): one dedicated operator per active task. Triages,
  recommends assignments/transitions/decisions, generates decision packets, triggers/re-engages
  specialists, decides when to deliver (push branch + open PR). Re-anchors on a fresh task
  snapshot every turn — no reliance on provider-side history (architecture.md line 888). Lives in
  `app/server/tasks/operator-actions.server.ts` + `operator-toolkit.server.ts` +
  `app/server/runtimes/operator-run.server.ts`.
- **Specialist agents** (FR19, FR21, FR22): execute stage work (developer, reviewer, etc.),
  append outcomes/blockers/evidence to the task record. Persistent threads resumable across
  stages; reactivated agents continue from canonical task state even if provider history is gone.
  `app/server/tasks/specialist-run.server.ts`, `agent-toolkit.server.ts`, `agent-reply.server.ts`.
- **Agent profiles**: reusable, admin-defined (global base + project customization — FR9).
  Each profile has eligible stages, permitted actions (capability grants), permitted context
  resources (skills/MCPs/KBs), permitted web reach (search/fetch egress + browser), and a backend
  (Claude or Codex).
- **Human owner** (FR37): each task can have ONE human owner = reviewer + acceptance authority,
  scoped to that task only. Distinct from the delivering/supporting engagements.
- **Runs**: an execution of an agent (operator or specialist) against a task via Codex/Claude
  Code backends — non-interactive. Lifecycle `queued|running|finished|error|interrupted`
  (ruling 11).
- **PRs / branches**: task-key branches, GitHub PRs opened by the operator's delivery decision
  (never by specialists directly — decisions.md ruling 21).
- **Decision/blocking packets** (FR26, FR27): structured, typed (`kind`-based, never English
  titles) objects an operator opens when human judgment is required. Ten kinds:
  `accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect,
  retry_other_backend, edit_goal, archive_task, discard_branch, custom` (ruling 7).
- **Knowledge Bases (KBs) / Skills / MCP servers** ("context resources", FR9): org-level catalog,
  granted **by store directory** (never display name — architecture.md line 890) to profiles.
  MCP grants sit OUTSIDE the capability matrix — granting a server IS the authorization to use
  its tools (ruling 39/R16-5).
- **Capabilities**: the agent-permission catalog (`app/shared/capabilities.ts`), each id has mode
  `direct | recommend | human | off`, plus an always-human invariant list (merge PR, transition
  to Done, change project policy). See §4.
- **Reviewers** (as a role concept): a human, or a supporting engagement holding
  `verdictCapable`, whose approval gates acceptance.
- **Audit trail / provenance**: typed important events in `task.md` + a separate `audit_events`
  SQLite table (org/auth-scoped events have no file counterpart, 90-day retention — FR33).

---

## 3. End-to-end intended workflow (with FR citations)

1. **Task created** — a human creates a task in a project (FR11: agents cannot create tasks;
   an agent that thinks one is needed routes it to a human via a decision packet). Created at
   the **entry stage only** (ruling 70/R19-14 — no dropping straight into e.g. Review).
2. **Operator triages** — the dedicated operator agent (FR18) reads the canonical task file plus
   a **full read-only clone of the project repo** (ruling 55/R19-1 — grounds packets in real
   repo contents, not guesses), flags underspecified/low-quality tasks for human clarification
   before execution (FR15), and recommends an assignment (FR20).
3. **Agent assigned / engaged** — a specialist engagement is created; exactly one is the
   delivering engagement (FR14). The operator can trigger and re-engage supporting engagements
   as needed (FR20).
4. **Run executes** — the specialist runs non-interactively through Codex or Claude Code (FR19),
   executes stage work, appends outcomes/blockers/evidence (FR21). Runtime continuity: if
   provider history is lost, the agent re-anchors on canonical task state and continues (FR22,
   NFR12, NFR17).
5. **Delivery** — pushing the task branch and opening the review PR is an **operator decision**,
   not a fixed stage side-effect (FR31, ruling 21/R15-2): the operator judges when work is
   plausibly ready, may open a decision packet if unsure, may offer early delivery when later
   stages (e.g. QA) aren't needed. The server executes the git/GitHub mechanics; specialists
   never push or open PRs themselves. A human can also trigger delivery directly (audited).
   Reaching a review stage with no PR is always announced via a typed event (never silent).
6. **PR opened** — task-key branch + PR tied to the task (FR31, FR32); branch/PR status visible
   alongside task state; a background reconcile poller (every 5 min) keeps this in sync with
   GitHub even for out-of-band changes.
7. **Review** — human or verdict-capable supporting-engagement reviewer(s) evaluate. Board/queue
   surfaces (FR24, FR25) prioritize current state → execution profile → latest decision packet
   before raw timeline.
8. **Accept / reject**: Human approval/rejection/redirect of consequential changes, including
   stage advancement and completion (FR27). Transition to `done` is **human by default,
   server-enforced**, with exactly one narrow exception: a project running its operator at
   **full autonomy** with an explicit `direct` **completion-for-acceptance** grant may accept
   and close the task itself (still refuses on failing validation; raising autonomy alone never
   grants this — it's a deliberate, audited grant — PRD lines 114, 246, ruling "Human-only"
   decisions.md:97-101). Human acceptance is **verdict-gated**: requires a healthy reviewer
   verdict on the delivered revision at every acceptance writer; Force-accept is the only bypass
   (audited, never bypasses PR-head-must-contain-delivered-commit). Every acceptance passes
   through a confirmation dialog naming what merges and any missing signals (ruling 20/R15-1,
   ruling 88/R21-5 makes this a **server-enforced** invariant, not just client UX).
9. **Merge** — `merge-pull-request` is `ALWAYS_HUMAN` (ruling 40/R16-6): only a *human*
   acceptance triggers the real async PR merge. A full-autonomy operator's acceptance instead
   records the PR `accepted` (**merge pending**) and moves the task to `done`, but a human must
   still complete the actual merge afterward — "Done" has two different meanings depending on
   who accepted, and the UI must disclose which.
10. **Alternate ending — "Completed, no changes"** (ruling 42-43/R17-2, R19-8): a task
    verifiably having nothing to deliver (empty diff or no branch) closes to `done` through
    acceptance without a PR/merge, as its own typed timeline event, still passing the full
    verdict gate.

Throughout: typed important events capture quality flags, transition requests, blocked
decisions, completion reports, policy violations (FR16, FR35); branch/commit/PR references stay
uniquely traceable to the task key (NFR15); external actions are idempotent-safe (NFR16);
everything is auditable (FR33, NFR10, NFR18).

---

## 4. RBAC model (high level)

Three deliberately **separate** systems (ruling 2, decisions.md:137-150; PRD "Permission
boundaries between humans and agents" lines 110-114):

### 4.1 Org roles
`admin | member` (schema tolerates `viewer` but UI uses admin|member). Org admins manage
membership/human roles (FR2) and org-wide resources (KBs, skills, MCP catalog, connections).
**Project creation is self-serve for ANY signed-in user** — not admin-gated (ruling / FR5
amendment, PRD lines 214) — the creator becomes that project's admin.

### 4.2 Project roles (strict tier, one source of truth: `app/shared/rbac.ts`)
`admin | maintainer | contributor | viewer` (originally `reviewer`, renamed to `contributor`).
- **admin**: full project configuration, RBAC/policy, credentials, Force-accept, member releases.
- **maintainer**: run agents, deliver, accept (subject to verdict gate), configure within
  bounds.
- **contributor**: take/release **own-task** ownership (floor is contributor, not viewer — FR38
  amendment, PRD line 210), comment, act on tasks they're engaged/own.
- **viewer**: read-only; cannot see the project credential card even if present (ruling 65/
  R19-11 — a withdrawn-not-disabled affordance; loader-level redaction).

**Membership gates almost everything**: projects are **members-only surfaces** (ruling 25/
R15-4) — a non-member cannot open a project's board or tasks at all (404-equivalent), overriding
the earlier "app-wide commenting" reading of FR4. `view` and `comment` are otherwise app-wide
for any authenticated user *within projects they can see* (FR4).

**Task-owner authority** (FR37, widened by rulings 22-23/R15-3 and R14-2): a task's live owner
(contributor+) governs **any open decision on their own task** — resolving decision packets,
applying/dismissing recommendations including stage-transition moves their role couldn't
otherwise authorize from the stage menu. The Apply click IS the authorization for that one move
only; it grants nothing elsewhere, and each decision's underlying action still needs its own
capability gate.

### 4.3 Agent capability policy (per profile, separate from human RBAC)
Id-based against a shared capability catalog (`app/shared/capabilities.ts`), each capability's
mode is `direct | recommend | human | off`. **Specialists** are `direct` or `off` only —
`recommend` is dropped for the specialist kind (ruling 81/R20-6); **operators** keep real
`recommend`. An **always-human server invariant list** exists regardless of any grant: merge PR,
transition to Done, change project policy (ruling 2; narrowed only by the explicit
completion-for-acceptance exception above). A capability set to `off` is a **hard refuse on
every route** — no card, no audit row generated as if it happened (ruling 60/R19-6). **Per-run
autonomy is a ceiling, never a pin** on the project's configured operator autonomy — a run may
choose *less* autonomy but never more (ruling 67/R19-A). MCP server grants sit **outside** this
matrix entirely: granting a server is itself full authorization for whatever that server's tools
can do (ruling 39/R16-5) — this is a deliberate honesty boundary, not a gap, and it is disclosed
in the capability-matrix UI.

---

## 5. Index of numbered decisions/rulings (lookup table)

Format: **ruling — one-line essence**. Source: `docs/architecture/decisions.md`. "SUPERSEDED"
markers in the source are preserved here; do not treat a superseded rule as current.

### Core model / RBAC / readiness (1–16)
1. Readiness is a canonical 4-value enum (`ready|input_required|inconsistency_risk_detected|blocked`); "accepted" is a derived display state, never stored.
2. **Three separate systems, kept separate**: org roles, project roles (now admin/maintainer/contributor/viewer, one table `app/shared/rbac.ts`), agent capability policy (id-based, `direct/recommend/human/off`, always-human invariants). Projects are members-only (superseded-in-part by ruling 25).
3. Task file store path convention; UI renders real store-relative paths.
4. UTC ISO timestamps everywhere; one shared formatter.
5. PAT scope violations are per-scope, server-derived, with open/resolved records; no global boolean.
6. Compare identity by user id everywhere, never by display name.
7. Packet options carry a stable `kind` (10 kinds total, see §2.2); human-only PR merge on accept, EXCEPT full-autonomy operator (amended by ruling 40).
8. `tweaks-panel.jsx` not ported (dev harness). Review-queue mechanics ship before the queue surface.
9. Notifications are per-user SQLite rows, soft refs to task/project.
10. "Waiting on you"/review queue stay project-wide, EXCEPT the board's "Waiting on me" chip is member-scoped (superseded for board only, R8-3).
11. Run lifecycle states `queued|running|finished|error|interrupted`; raw NDJSON is truth, display is a projection.
12. PR state → pill mapping (merged=done, open/draft=in review, closed-unmerged=risk "closed").
13. Prefs: drop `ghConnected`; no mailer, so email/nudge prefs removed, single in-app `app` toggle per category.
14. Shared single implementations for notification meta, markdown stripper, credential card, bell popover — never fork per surface.
15. Stages are per-project in `project.md`; Standard 5-stage is the ONLY creation template (Lightweight 3-stage deleted).
16. Deliberate keeps (board rail counts Done, `.card.urgent` untreated, `data-screen-label` kept) + additions (list-view empty state, Escape/focus-trap/scrim-click on dialogs, operator stores stage id not label, password min 8 chars).

### Delivery, acceptance, PR mechanics (17–22, 34–43, 62, 76–77, 85, 88, 97)
17. PR divergence recovery: reconciler fires `pr-diverged` trigger on out-of-band close/merge/reopen; operator opens ONE recovery packet.
18. Minimum GitHub scopes are exactly `repo` + `pull_request:write` (dropped `workflow`, `read:org`).
19. Scope chips render PROVEN verdicts only (never a pseudo-check for assumed/unchecked).
20. **R15-1: acceptance requires a healthy reviewer verdict on the delivered revision**; admin Force-accept is the only bypass; every accept shows a confirm dialog.
21. **R15-2: delivery (push+PR) is an operator decision**, not a stage side-effect; human delivery button is the escape hatch; specialists never push/open PRs.
22. **R15-3: task owner may apply/dismiss ANY operator recommendation on their own task** (the click is the authorization).
34. **R15-15: a task owns a PR only if that task opened it** — reconciler never mints a new link; unowned matching PR on the branch = a COLLISION, reported not adopted (task-key branches aren't unique identifiers across data-root resets).
35. **R16-1: pre-existing PR adoption requires OPEN + head-sha === delivered revision** (identity, not mere containment) — extends 34.
36. **R16-2: `input_required` joins the board's "Blocked or waiting" attention filter** (renamed from "Needs attention").
37. **R16-3: a terminal GitHub fact (closed PR) outranks process gates in refusal copy**; Force-accept is WITHDRAWN (not disabled) while the PR is closed.
38. **R16-4**: correctness+tests first, then full UI/a11y — nothing deferred out of a pass.
39. **R16-5: MCP grants sit outside the capability matrix** — granting a server IS the authorization for its tools, even overriding a withheld `execute-code-or-write-repo`.
40. **R16-6: merge stays human-only — "Done" has two meanings.** Full-autonomy operator accept = PR "accepted"/merge pending + task Done; only human accept triggers real merge.
41. R16-7: stale branch cleanup housekeeping note (not product-relevant).
42. **R17-1: acceptance may accept a head AHEAD of the reviewed revision but MUST surface the divergence** (accept dialog + force dialog + audit log show actual merge head).
43. **R17-2/R19-8 (62 supersedes the verdict-optional clause): "Completed — no changes" is a first-class outcome** for a verified empty diff/no branch — closes to Done without PR/merge, still passes the FULL verdict gate, its own timeline event.
62. R19-8: no-change completion passes the SAME verdict gate as any other acceptance (supersedes ruling 43's "verdict optional"); requires `defaultBranchEvidence.verified` on both doors.
76. **R20-1: confirming a recovery option RESOLVES the packet + re-queues the operator**; no repeat confirms; labels state real effect.
77. **R20-2: `accept_completion` re-verifies ACTUAL branch state**; new `discard_branch` packet kind (10th) deletes a never-pushed local branch on confirm.
85. **R21-2: a capability-gap packet must NAME the product's own remedy** (grant the capability on Agents page) alongside workarounds — operator still never changes config itself.
88. **R21-5: acceptance ceremony (disclosure dialog) is a SERVER invariant**, not just client UX — a bare POST without the disclosure echo is refused.
97. **The live-backend display law (#183): every surface shows the backend a run would ACTUALLY use** (live deployed profile, not a stale engagement-time snapshot).

### Autonomy, operator behavior (48, 53-61, 63-64, 67, 78, 84, 89-92, 94, 96, R22)
48. **R18-2: full-autonomy delivery re-queues the operator** (supervised deliberately does NOT — human is the driver).
53. **R18-7: accepting from the board asks first** (drag-to-final-stage / keyboard Move triggers the same confirmation contract as task detail).
55. **R19-1: operator gets a FULL read-only clone of the project repo before triage** (not a summary; must be grounded in real repo contents; clone reused by the later delivering agent).
56. **R19-2: repo-documented conventions OUTRANK knowledge bases**; KB supplements where repo is silent; genuine conflicts are followed repo-first AND reported by name (typed context-conflict event).
58. **R19-4: a SUPERVISED delivery must leave an actionable next step, guaranteed by the SERVER** (not left to model memory) — `ensureDeliveredNextStep`.
59. **R19-5: force-accept MAY skip remaining stages/review gate, but must SAY so** (labeled + enumerated in confirm dialog); never bypasses a closed-PR terminal fact or PR-head containment.
60. **R19-6: a capability set to `off` is a HARD REFUSE by every route** — no card, no audit row, even via rerouting through another action path.
61. R19-7: Activity audit column compacts consecutive routine runtime-session-open rows (UI legibility, anchored at the sentence end to avoid a self-named-actor exploit).
63. **R19-9: numeric NFR1-4 performance targets DROPPED from canon** ("a target nobody measures is a claim, not a requirement"); replaced by qualitative requirements. NFR5 kept as a behavioral (not timing) requirement — it's actually enforced (bounded timeline slice).
64. **R19-10: two previously-unshipped spec'd components get BUILT** — Continuity Recovery Panel, board arrow-key traversal — rather than becoming deliberate divergences.
67. **R19-A: per-run autonomy is a CEILING on the project's configured operator autonomy, never a pin** — a run may choose less, never more; clamp is audited only when it bites.
68. **R19-B: a project member's GitHub PR approval counts as the approving verdict** (bound to delivered revision's commit_id, approver must be a linked project member, fails closed, never silent).
78. **R20-3: the provider's OWN failure words reach the packet/timeline (redacted)**; model availability validated against a real 400, not a synthetic probe.
84. **R20-9: the operator MAY gather a delegated ask itself at triage**, but the packet must disclose it's standing in for the delivering agent (mechanically enforced on packet-open, not just prompted).
89. **R21-6: the triage quality gate stays BEHAVIORAL** — no mechanical block on stage transitions while an input-required packet is open (a human moving past it is deliberate, not an accident to prevent).
90. R21-7: `FILES.md` deleted, not regenerated (housekeeping).
91. **R21-8: while an agent actively works a task, `input_required` YIELDS to "agent working"** on every surface (hero, board card, filter) — `waiting === "agent"` is the gate; `blocked`/`inconsistency_risk_detected` never yield.
92. **R21-9: backend display label is "Claude" (not "Claude Code"); run control SHOWS config, does not PICK it** — no per-run backend/autonomy dropdowns; both come from the deployed profile.
94. **R22-schedule: a scheduled operator re-run resolves the LIVE deployed profile at fire time** — supersedes FR39's original "pin backend/autonomy at schedule time" — no schedule-time clamp needed since nothing is stored to clamp.
96. **The attachments drop (#179): ANY run granted `attach-evidence-references` may post files** on the task thread into `attachments/`, rendered as timeline thumbnails; browser screenshots are a special case of this general mechanic.
93/R22. **R22: the Codex OS process sandbox is REMOVED** ("viberr itself is the sandbox") — only a fully-autonomous delivering run with web egress gets `danger-full-access`; everything else is `workspace-write`; the real boundary is the container + server-owned delivery gate (push/PR/merge/Done are server actions no agent tool reaches), not the OS sandbox mode.

### Browser capability / MCP / KB / skills (39, 47, 49-52, 56-57, 73-75, 79, 95)
39. See above (R16-5, MCP outside matrix).
47. **R18-1: a REVIEWER engagement inherits the DELIVERING engagement's KB grants (union, deduped)** so deliverer and reviewer judge against the same conventions; re-affirmed KBs-only by ruling 57.
49. **R18-3: the SDK-native skill/command catalog is governed OUT of runs** — a run's own workspace `.claude` catalog is stripped before execution (git-invisibly); only Viberr-granted skills/MCPs reach the run (`strictMcpConfig: true`).
50. **R18-4: branch-collision stays a human-gated packet — do NOT auto-reset** a stale remote task branch.
51. **R18-5: granted skills reach Claude via the SDK's NATIVE skills mechanism** (`skills: [...]`, progressive disclosure), not injected prompt text; Codex keeps prompt-text injection (disclosed asymmetry).
57. **R19-3: reviewer inheritance stays KBs-only** — skills are DELIBERATELY not inherited (re-affirms/corrects a false docstring, closes F19-2).
73. **R19-17: a failed MCP command's own stderr is captured/redacted/persisted and shown**, not silently dropped.
74. **R19-18: first-run MCP (uvx) installs finish in the BACKGROUND** (15-min warm-up cap) rather than restarting from zero each retest.
75. **R19-19: agents get a REAL BROWSER as a first-class capability** — `use-browser`, default OFF, mounted/withheld per run via a Viberr-owned Playwright MCP on both backends; chromium ships IN the app image; output lands in task `attachments/`. (Amended by 95/96 below.)
79. **R20-4: npx/bunx-style first-probe timeouts are also treated as visibly-installing** (extends R19-18's uvx-only background-warmup to npx/bunx).
95. **Browser implies egress (#176): granting `use-browser` FORCES `use-web-search-fetch` to `direct`** at every profile save path — the browser IS network egress; no "browser granted, egress withheld" state is allowed (unlike other capabilities' respect-the-explicit-off posture).

### Auth / login / org config (45, 65, 72)
45. **R17-4: local sign-in form leads when NO OAuth provider is configured** (no dead disabled SSO buttons up top).
65. **R19-11: a read-only Viewer cannot see the project's GitHub credential card at all** — withdrawn (not disabled), loader-level redaction (extends members-only posture to "may you see what's inside").
72. **R19-16: OAuth sign-in is configured IN THE APP** (org-settings Sign-in & SSO tab), not via env-var-only; requires a passing credential test before enabling; saved creds override env.

### Docs / process / linting hygiene (27, 44, 52, 54, 86)
27/52. **R15-8/R18-6: `design/prd.md` mirror is re-synced to canon and pinned by a test** (byte-identical, `prd-sync.test.ts`).
44. **R17-3: rulings live in `decisions.md`; a docs-canon re-read is a required closing step of every pass** — an uncommitted-to-canon ruling is a ruling that gets silently reversed.
54. **R18-8: a specific finding (agent-profile modal default-ON skills) closed as NOT REPRODUCIBLE** — recorded as a class: an unverified UI impression can survive as "fact" across passes.
86. **R21-3: the oxlint `anti-slop` linter is ADOPTED as a required CI gate** — reverses the earlier "no linter, by decision" architecture text.

### Accessibility / UX correctness (32-33, 66)
66. **R19-12: two contracts become MECHANICALLY ENFORCED gates**, not prose: (1) both-theme WCAG AA contrast sweep (unenumerated, systematic), (2) "no control hidden/disabled at any width, nothing gated on `matchMedia`" — hiding a control on narrow viewport is ruled a **correctness bug**, not a layout choice.

**Full numbered list is long (97 rulings + several `#NNN`-tagged owner asks); the above groups the ones most load-bearing for hands-on testing.** For anything not indexed here, grep `docs/architecture/decisions.md` for the ruling number cited in a code comment — the file is the source of truth and numbers are never renumbered/reused.

---

## 6. Explicit divergences ("amendment"/"superseded" notes — deliberate product choices)

These are places where the PRD/architecture/UX docs flag that the shipped app **deliberately
diverged** from the original design, and the document was corrected to match the app (not
vice versa). Do not treat the original/superseded text as current behavior; do not "fix" the
app back toward it.

1. **Vocabulary: "primary specialist + consultant specialists" → "engagements" model.**
   (PRD FR14 amendment, lines 226; architecture line 73, 178.) Struck 2026-08-06, pass 19.
2. **Task-level repo override was never built; the toggle was deleted, not finished** (FR7,
   PRD line 216) — nothing ever wrote a task-level repo and the admin toggle enforced nothing.
3. **V1 clause "and authorized agents" struck from FR11** (PRD line 223) — agent-initiated task
   creation was never implemented on any layer; task-graph/subtask orchestration is post-MVP.
4. **Project creation is NOT admin-gated** (FR5, PRD lines 214) — self-serve for any signed-in
   user, confirmed as deliberate (the neighboring re-scan/rebuild actions DO carry an explicit
   org-admin refusal on the same route, by contrast).
5. **FR38 "Any member" corrected to "contributor+"** (PRD line 210) — the code was right
   (floors own-task ownership at contributor since ownership carries reviewer/acceptance
   authority a viewer must not self-assign); the *requirement text* was fixed to match code.
6. **OAuth-first login was never the shipped default** (architecture.md lines 297-303) — local
   email+password is the first-class default; OAuth is optional/off unless configured, on a
   strict whitelist (no self-signup on any path).
7. **Responsive "review-first mode below 768px" was never built and is retired** (PRD line 161,
   UX spec line 901) — Viberr ships **one capability mode**, reflowed not reduced; every action
   including destructive/governance ones renders at every width. Hiding a control on narrow
   viewport is treated as a correctness bug (ruling 66/R19-12), not an accessibility nice-to-have.
8. **NFR1-4 numeric performance targets (2s board render, etc.) were dropped from canon**
   (PRD lines 267, ruling 63/R19-9) — never measured by any harness; replaced with qualitative
   requirements. NFR5 (bounded timeline rendering) survived because it's actually enforced.
9. **"No linter, by decision" was reversed** (architecture.md lines 408, 587, ruling 86/R21-3) —
   oxlint + a vendored `anti-slop` plugin is now a required CI gate.
10. **Design-system mock values (`design/design-system.html`) are NOT the shipped token source**
    — colors (steel-blue → `#5b76fe`), radii (18/28px → 16/22px), fonts (Roobert PRO →
    Manrope/Noto Sans/JetBrains Mono) all diverged; `app/app.css`'s `:root` is the only real
    source (UX spec lines 249-397, architecture.md's N19-4 notes).
11. **No spacing scale / no 12-column grid were ever built** (UX spec lines 398-414) — rem
    values chosen per component instead; retrofitting a scale was explicitly rejected as
    not worth the tree-wide touch.
12. **`e2e` job runs against the production Docker image, never a real dev server** (as the
    spec once implied) — owner policy since 2026-08-02 (architecture.md lines 965).
13. **Browser test matrix is Chromium-only in practice** — Safari/Firefox are declared "support
    intent" in the PRD but have never been exercised, automated or manual, in any pass (PRD
    line 160, architecture.md lines 966, UX spec line 949). Recorded as a gap, not silently
    claimed as covered.
14. **`attachments/` directory went from "specified, never implemented" to fully real**
    (architecture.md line 824) — shipped 2026-08-14 under ruling 75/R19-19 and generalized by
    ruling 96 (#179); FR9/FR17 amendments record this since the architecture doc had never
    caught up.
15. **The browser capability (`use-browser`, ruling 75/R19-19) itself is the single largest
    post-pass-19 capability that the PRD/architecture never recorded until pass 22** — treat
    FR9's 2026-08-21 amendment (PRD line 218) as the first canonical mention.
16. **FR27's human-only "done" transition gained one deliberate, audited, narrow exception**
    (full-autonomy operator + explicit `completion-for-acceptance: direct` grant) — this is an
    owner ruling (Q1), not a default, and it still never confers the actual PR *merge*, which
    stays `ALWAYS_HUMAN` (ruling 40/R16-6).
17. **FR39's "the scheduled run carries the backend/autonomy chosen at schedule time" clause is
    struck** (PRD line 239, ruling 94/R22-schedule) — a fired scheduled run resolves the LIVE
    deployed operator profile instead, for the same "surface shows, doesn't pick" reason as the
    manual run control (ruling 92/R21-9).
18. **Two UX-spec components (Continuity Recovery Panel, board arrow-key lane traversal) were
    "ruled built" rather than allowed to become permanent gaps** (ruling 64/R19-10) — treat them
    as intended-and-shipped, not aspirational, when testing.
19. **`docs/architecture/decisions.md` itself is a recovery artifact** — the original
    `docs/build/CONVENTIONS.md` was deleted in a cleanup commit (`c1acf2c`) while still cited by
    ~26 code comments; decisions.md line 8-14 explains it was reconstructed with ruling numbers
    preserved verbatim so citations still resolve. This is itself the case study behind ruling
    44/R17-3 ("a ruling no canon file records is a ruling that gets reversed").

---

## 7. Where to look for more detail

- Canonical file formats (task.md/project.md frontmatter, timeline grammar, packet schema):
  `docs/architecture/file-formats.md` (referenced throughout, not itself re-read for this doc).
- RBAC grant table (ground truth, not just this summary): `app/shared/rbac.ts`.
- Capability catalog (ground truth): `app/shared/capabilities.ts`.
- Readiness derivation (ground truth): `app/server/interpretation/readiness-policy.server.ts`.
- Route map: `docs/architecture/decisions.md` (final section, lines 1267-1286).
- Known deliberate V1 gaps (no mailer, no org audit UI, 90-day audit retention, no cleartext-
  transport guard, notifications cap at 200 rows, PAT validation partly probe-based):
  `README.md` lines 230-256.
- Prior discovery-pass findings/session memory (useful for "what's already been tested and
  fixed" context, NOT part of canonical product intent): `planning/discovery-2026-08-*-pass*/`
  directories, most recently pass 28 (`planning/discovery-2026-08-26-pass28/`).
