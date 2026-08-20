# PRD / UX-spec alignment — pass 21

> **Verified 2026-08-19** against the worktree at
> `/Users/akinozer/projects/viberr/.claude/worktrees/viberr-app-inspection-1fe423`,
> HEAD `ce2bc9e` ("Fix anti-slop lint findings across the codebase (2,843 -> 26)"),
> tree identical to `main`.
>
> **Canon read:** `planning/planning-artifacts/prd.md`,
> `planning/planning-artifacts/ux-design-specification.md`,
> `planning/planning-artifacts/architecture.md`, `docs/architecture/decisions.md`
> (rulings 1–83), `planning/README.md`.
>
> **Method.** Per `planning/README.md` the three planning artifacts are *living*:
> where the app and a doc disagree and the app is right, the doc is corrected with
> an amendment note. So an amendment note is a sanction, not a defect. Every claim
> below was re-derived by reading the tree at HEAD — the pass-20 analysis
> (`planning/discovery-2026-08-14-pass20/PRD-ALIGNMENT.md`) was used only as a
> checklist of what to re-verify, never as evidence. Pass-20's fixes have merged;
> each of its 13 drift items (D1–D13) and 14 coherence items (C1–C14) was
> re-checked in code, and the ones that landed are **not** re-filed here.
>
> **No app code was modified in producing this document.** This file is the only
> artifact this analysis owns.
>
> **Section map:** §0 is the product narrative (task item 4). §1 is the
> still-unmet requirement list (task item 1). §2 is the sanctioned-divergence list
> (task item 2). §3 is the undocumented-divergence list (task item 3) — the
> critical one. §4 summarises.

---

## §0 · What the product is supposed to be

*(Synthesis of the PRD's intent. An implementer who reads only this section should
be able to make correct product judgements without opening the PRD.)*

**Viberr is a governed-delivery layer for agent-native software work.** It is a
multi-user, authenticated, desktop-first web app for a small AI-forward
engineering team. The premise: coding agents have become good enough to do real
delivery work, but task systems are still human-native, so multi-agent work has
no durable operating layer. Viberr supplies that layer.

**The one load-bearing idea: the task is the canonical operating contract.** Not a
ticket pointing at the real work — *the* record. Each task is a real file on disk
(`$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`, ruling 3) holding
identity, goal, state, execution context, timeline, decisions and execution
references (FR12). SQLite is a rebuildable projection of those files, never the
truth (architecture.md §Structure Alignment). Everything else follows from this:
an agent that loses its provider-side history re-anchors on the file and keeps
going (FR22, NFR12, Journey 4); a projection rebuild loses nothing; a human can
read the file outside the app (FR10).

**The responsibility model is inverted, and that is the differentiator.** In
Jira-like tools humans are the default workers and AI helps at the edges. In
Viberr **agents are the native workers and humans govern**: they set policy,
comment, decide, and explicitly authorize the consequential moments. Every
surface exists to make that model legible rather than to move tickets.

**How work actually runs.** Each active task gets a **dedicated operator agent**
(FR18) that triages, recommends, engages specialists and decides when the work is
ready to deliver (FR20, FR31/ruling 21). The task carries one uniform
`engagements[]` list: exactly one engagement `delivers: true` — the **delivering
engagement**, sole writer of workspace, branch and PR (the single-writer
invariant) — and any number of **supporting engagements**, read-only by default; a
supporting engagement with a `verdictCapable` snapshot is a **required reviewer**
(FR14 as amended; the old words "primary specialist"/"consultant" are retired).
The task's **human owner** (FR37) is tracked separately as its reviewer and
acceptance authority, and governs any open decision on *that* task only. Runs
execute on Codex or Claude Code non-interactively (FR19).

**Governance is expressed as three separate systems, deliberately not merged**
(ruling 2): org roles (`admin|member`); project roles
(`admin | maintainer | contributor | viewer`, a strict tier, single-sourced in
`app/shared/rbac.ts`); and a per-project **agent capability policy**
(`direct | recommend | human | off` per capability id). Governing people and
governing agents are different problems (Journey 3). Some actions are
**ALWAYS_HUMAN** server-side — merging a PR, transitioning to `done`, changing
project policy.

**Completion is the ceremony the whole product protects.** Acceptance is
verdict-gated: it needs a review PR whose head carries the delivered revision and
a healthy verdict on *that* revision (ruling 20), which may come from a
verdict-capable agent reviewer or from a project member's GitHub PR approval bound
to the delivered commit (ruling 68). There are four sanctioned endings and the
differences are load-bearing: (a) a **human** acceptance triggers a real async
merge; (b) a **full-autonomy operator** holding an explicit
`completion-for-acceptance: direct` grant reaches `done` with the merge still
**pending** — it may never merge (ruling 40); (c) **"Completed — no changes"** for
a verified-empty diff, no PR, no merge, re-proven against the live remote at the
moment of close (rulings 43 + 62 + 77); (d) an audited admin **force-accept**,
which may skip stages and the review gate but must *say* so (ruling 59). Every one
of them passes through a confirmation dialog that names what merges and what
signals are missing.

**GitHub is the execution surface, one repo per project** (FR7, FR30). Branches
are task-keyed, commits and PRs trace back to the task key (FR31, NFR15), and
delivery — push plus opening the review PR — is an **operator decision**, not a
side-effect of reaching a stage (ruling 21). Specialists never push or open PRs.

**The UX job is triage-first supervision, then operator-first clarity.** The board
is a *signal console*: each card shows stage, assigned agent, waiting state and
validation health so a human can allocate attention without opening anything
(FR24). The task page is an *operator desk*: current state, execution truth and
the latest decision packet come before timeline depth (FR25, NFR2). Intervention
is meant to feel like a strength — a blocked task produces a compact, structured
**decision packet** with observed issue, options and a required decision, not a
wall of agent chatter (FR26, Journey 2). Five anti-noise guardrails are named MVP
scope and all five ship (`app/server/tasks/comment-guardrails.server.ts`):
meaningful-comment, operator brevity, no-duplicate-summary, compression-threshold,
evidence-separation.

**Non-negotiables to hold in mind while changing anything.** Files are the only
canonical business truth. Tolerant parsing produces diagnostics plus a readiness
downgrade — never a crash, never a silent drop (architecture.md line 575:
*"silent parse fallback is forbidden"*). Readiness is exactly four values. Secrets
never reach files under `projects/`, timelines, logs, SSE payloads or error
messages (NFR7). Every governed action writes an audit row (90-day retention,
FR33) and, where user-visible, a typed timeline event. No optimistic UI for
governed state. WCAG 2.2 AA is the baseline for core workflows in **both** themes,
at **every** width — nothing is hidden or disabled below a breakpoint, because a
surface that hides a governance control is lying about what the user may do.

**What it is not.** Not a GitHub-review replacement, not a generic AI assistant,
not a mobile product, not a public/marketing surface. Post-MVP: analytics,
task-graph/subtask orchestration, audit export, richer profile templates.

---

## §1 · Requirements still NOT met

Each row states the requirement, what the code actually does at HEAD, the size of
the gap, and whether a prior ruling already dispositioned it. **HELD** items are
*not* open gaps — ruling 80 (R20-5) deliberately kept them out of pass-20 scope as
never-built features rather than corrections. They are listed so the next
implementer knows the ledger is complete, not to re-open the decision.

### 1.1 HELD by ruling 80 (R20-5) — never-built PRD/UX features, deliberately out of scope

| # | Requirement | What ships at HEAD | Gap | Disposition |
|---|---|---|---|---|
| **H1** | **UX spec §Decision Packet, Anatomy** — "packet type, **severity**, observed issue, **impact summary**, recommended options, **confidence/risk framing**, next action area"; **States** — "informational, warning, blocked, completion-ready, policy-related, continuity-related"; **Variants** include a "continuity-recovery packet". Also §Semantic Product Patterns, **Packet Severity Pattern**. | `taskPacketSchema` (`app/schemas/task-file.schema.ts:413-439`) carries `type: "input" \| "blocked"`, a free-string `kind` label, `title`, `body`, `observations[]`, `options[]`. There is **no** `severity`, **no** `impact`, **no** `confidence` field. Only four kind labels are ever produced across `app/server/` — "Decision required", "Blocked decision", "Completion report", "Agent question" — so informational/warning collapse into one, and **policy-related and continuity-related packets have no producer at all** (the only `continuity` writer is a typed timeline event, `app/server/runtimes/run-service.server.ts:657`). | MED — three schema fields plus a packet-state vocabulary. Impact/confidence exist today only as free prose inside `body`. | **HELD** — ruling 80 (R20-5) names "**D7** (the three dropped Decision-Packet anatomy fields — impact / confidence / severity)". The missing *states* and the continuity-recovery *variant* are the same D7 item's canon quote; treat them as inside the hold. |
| **H2** | **UX spec §Continuity Recovery Panel, States** — "degraded but recoverable, **escalated**, **paused pending review**, recovered". Ruling 64 (R19-10): "the anatomy, states, and content guidance above stand as the build target." | `app/features/task-detail/continuity-recovery.tsx:94-102` defines `ContinuityProgress = "running" \| "recovered" \| "stalled" \| "unknown"` — a *per-thread recovery progress*, not the panel's four spec'd states. `escalated` and `paused pending review` exist nowhere in the type or the tree, so the "escalation options" the anatomy names have no state to move into. | LOW-MED | **HELD** — ruling 80 names "**D10/D11** (the missing Continuity-Recovery-Panel escalated / paused states …)". |
| **H3** | **UX spec §Execution Truth Strip** — "**Top section** of task detail", anatomy "branch status, PR reference, validation state, **runtime continuity state**, latest sync health". | The facts exist and are well built, but as three components in two columns: `GithubTrace` and `CurrentStatePanel` sit in `.detail-side` (the 340px right rail — `app/features/task-detail/task-detail-page.tsx:726-743`, `app/app.css:1005-1019`), validation lives in the hero chip row, and runtime continuity is the separate panel of H2. No single "strip", and no continuity fact inside it. | LOW-MED | **HELD** — ruling 80 names "…and the Execution-truth-strip runtime-continuity fact". |
| **H4** | **UX spec §Additional Patterns** — "Skeletons or placeholder structures are preferable to large spinners when the page shape is already known." | No skeletons anywhere: the only match for "skeleton" in `app/` is a comment in `app/features/shell/route-pending-bar.tsx:11`. Loading is the top route-pending bar plus inline fetcher pending states. To the app's credit there are no large spinners either, so the anti-pattern the sentence guards against is absent. | LOW | **HELD** — ruling 80 names "**D12** (skeleton loaders)". Defensible as-is. |

### 1.2 Open gaps with NO prior disposition

| # | Requirement | What ships at HEAD | Gap | Disposition |
|---|---|---|---|---|
| **G1** | **PRD §Web App Requirements, Browser matrix** — "current Chromium-based browsers, current Safari, and current Firefox desktop". **UX spec §Testing Strategy** — "test Chromium, Safari, and Firefox on current desktop versions". | `playwright.config.ts:42-48` declares exactly one project, `chromium` (`devices["Desktop Chrome"]`). `.github/workflows/ci.yml` installs `chromium` only. Nothing in the repo has ever exercised WebKit or Gecko: no `webkit`/`firefox` project, no manual-verification note in any pass's records (`grep -ri` across `planning/` and `docs/` returns only the PRD/UX-spec statements themselves and one 2026-07 aside about Safari 404 log spam). | MED — two thirds of a declared support matrix are unverified. This is the shape ruling 63 (R19-9) struck four NFR numbers for: an asserted requirement with nothing that goes red when it is missed. | **NONE.** No ruling, no amendment. Two honest branches: add `firefox`/`webkit` Playwright projects for a smoke subset, or amend the PRD's matrix to what is actually verified. See also §3/U6. |
| **G2** | **UX spec §Testing Strategy, Accessibility testing** — "screen-reader testing for core flows using VoiceOver and NVDA at minimum"; **§Critical journey coverage** — board scan, blocked-task decision flow, continuity recovery "explicitly tested across breakpoints and with assistive technologies". | Automated a11y coverage is real and growing (`app/app.css.test.ts` §R19-12 gates at lines 1298, 1775, 2211, 2345; axe in the e2e suite; roving tab stop and `aria-live` on the board). No AT session has ever been recorded, for any journey, in any pass. | LOW-MED — a testing-strategy requirement, not a product behaviour; but it is the only check on §3/U7 below, which is exactly an AT-order defect that automation did not catch. | **NONE.** |
| **G3** | **UX spec §Accessibility Strategy** — "touch targets large enough for **tablet and mobile review flows**". | Nothing sizes controls for touch; the product is pointer-and-keyboard throughout. | LOW — and the requirement is arguably self-cancelling. | **PARTIALLY dispositioned, and contradictory.** PRD §Web App Requirements (amended 2026-07-25) and UX spec §Responsive Strategy both retired the mobile/review-first mode — "Mobile and legacy browsers are not V1 targets" — but this accessibility bullet still asks for touch targets for mobile review flows. The two halves of the same document now disagree. Correct the bullet; do not build to it. |
| **G4** | **FR15** — "Agents can flag low-quality or underspecified tasks and request human clarification **before execution proceeds**." | The flag/clarify channel is fully real: `ask_human` (`app/server/tasks/agent-toolkit.server.ts:275-331`) opens a packet, sets `waiting: "human"`, writes a `blocked` event, audits and notifies; the answer resumes the asking agent's own session (ruling 33). **Nothing gates on it.** The tool's own success string tells the agent to keep going — *"Continue whatever does NOT depend on the answer"* (`agent-toolkit.server.ts:316`). No run path consults an open packet: `transitionStage` (`task-actions.server.ts:3100-3460`) refuses only for an archived task and an off-boundary target, and the operator's `run_agent` / `prompt_agent` dispatch tools (`operator-toolkit.server.ts:389-433`) have no precondition at all. The "triage quality gate" is **prompt text only** — `triageQualityGate` (`operator-run.server.ts:2596-2618`) returns a string spliced into the turn, and `goalIsUnspecified` is read only to build that string. The two named capabilities `post-quality-flags` and `flag-underspecified-tasks` are explicitly inert (`app/shared/capabilities.ts:122`, "Advisory persona guidance (no runtime consumer)", pinned by `capabilities.test.ts:71`). The one enforced refusal sits at **acceptance** (`task-actions.server.ts:5937`) — the end of the pipeline, not the start. | MED — the flag is real, the *precedence* is not. An agent that judges a task underspecified raises a card and keeps burning paid turns on the ambiguous goal, and the operator can dispatch the next agent while the question stands. | **NONE.** No ruling makes the gate advisory-only. See §3/U5 for the UI copy that promises otherwise. |
| **G5** | **FR28** — "Users can review current task progress **without needing raw provider logs** or raw validation output." | Everything *after* a run is genuinely digested — typed timeline with an Important-events filter, validation rendered as a composed sentence from the derived value, raw fenced output trimmed out of agent prose by the guardrails, digested pills, and raw logs behind a member-gated disclosure. **Live progress is the hole.** `LiveRunPanel` renders `run.phase` and `run.step` (`app/features/runtime/runs-panels.tsx:213-214`); the DB writer `sink.phase()` is called from exactly one place, the adapter callback wiring at `app/server/runtimes/run-service.server.ts:858-860` — and **no adapter ever invokes that callback**. A tree-wide grep for `onPhase` / `.phase(` in non-test code returns three hits: the interface declaration (`adapter.server.ts:127`) and the two wiring lines. The only non-null phase value in the tree is a test fixture. | MED — while a run is in flight the panel shows elapsed / turns / tokens and **two empty rows** where "what the agent is doing right now" belongs, so the only way to see current activity is to open the raw agent console: exactly the dependency FR28 forbids. | **NONE.** Either implement `onPhase` in the two adapters or drop the two rows and the dead sink. |
| **G6** | **NFR9** — "least-privilege access for GitHub **and runtime-provider** credentials based on project policy and active task context." | **GitHub half: met, and strongly.** Every call funnels through `getProjectGithubContext` (`app/server/github/github-context.server.ts:46-81`) which fails typed rather than falling back to an ambient token; PATs are AES-256-GCM with one decrypt point; the token reaches `git` only through `GIT_ASKPASS`, never argv, never the URL (`app/server/tasks/git-clone-auth.server.ts:47-165`); and push is gated on *this task's* delivering engagement and that profile's project grant, fail-closed (`resolveDeliveryPushGrant`, `task-actions.server.ts:3421-3441`). **Runtime-provider half: not met.** The provider credential is process-global — read from server env at `app/server/runtimes/runtime-registry.server.ts:285-290, 355-398, 545-556`, with `createAdapters()` running once per process. Nothing consults project policy or active task before a run gets the provider key. (Blast-radius containment *is* excellent: `filteredSpawnEnv` strips every credential-shaped var from the agent's child process, `runtime-registry.server.ts:453-467`.) | MED — an org cannot bill, rate-limit or revoke provider access per project, and a low-trust project cannot be given a narrower credential. | **NONE.** Either scope provider credentials per project or amend NFR9 to say the runtime half is deployment-wide by design. |

### 1.3 Verified as MET (checked because a previous pass, or the doc's own wording, made them look open)

- **FR14/FR20 engagement model** — one `delivers: true` engagement plus supporting engagements, with `verdictCapable` required reviewers, is the shipped schema. MET.
- **FR9 "global base definitions with project customization"** — org templates plus per-project deployments carrying a `definition` override and their own capability grants (`app/features/agents/agents-query.server.ts:36-46, 332-384`). MET.
- **FR10 file-native store, reconciled when edited *or created* externally** — real chokidar watcher started on boot (`app/server/boot.server.ts:442`, `app/server/files/file-watch.service.server.ts:251-263`) whose ignore matcher deliberately admits a newly created task directory (`:110`), plus disk enumeration on rescan (`rebuilder.server.ts:274-280`). Hand-editability is actively defended: an external edit wins over the write cache (`task-writer.server.ts:91-118`) and the writer **refuses** (409 `FILE_NOT_TRUSTED`) to overwrite a file the parser could only read with fallback defaults (`:138-158`). MET.
- **FR17 (all four clauses)** — validation outcomes (single derivation `deriveValidation`, `task-file.schema.ts:608-659`), linked evidence references (typed `EvidenceRow`, sanitized with row/length caps `:1338-1365`, carried into the PR body's "## Evidence"), concise change summaries (`githubCacheSchema.changed`), and timeline compression that keeps every typed governance event, every human comment and the newest agent reply per run (`app/server/tasks/timeline-compaction.server.ts:50-109`). MET.
- **FR21 / FR22** — specialists append verdicts, blockers and evidence through `report_outcome` with a staged-outcome table so a restart cannot lose them (`agent-outcome.server.ts:286-314`); sessions resume across stages with **no stage filter** on thread selection (`agent-reply.server.ts:251-273`) and re-arm full confinement, with the canonical anchor ("Your session history is NOT the source of truth … THIS wins", `task-actions.server.ts:923-990`) on every fresh run. MET. **NFR17** likewise: continuity loss is an explicit typed event and a preamble, not a silent restart.
- **FR23 "access an agent's native runtime session"** — `/resources/session-export` hands a *member* a self-contained bash installer that embeds the provider's own `.jsonl`, drops it where the local CLI looks, and prints the exact `codex resume <id>` / `claude --resume <id>` command, carrying no credentials (`app/server/runtimes/session-export.server.ts:322-408`). Matches Journey 4's framing exactly ("a debug session, not the primary record"). MET.
- **FR33 / NFR18 audit retention** — verified end to end: `entry.server.tsx:21` → `boot.server.ts:355,465` → `maintenance.server.ts:150` → `retention.server.ts:76-85`, a literal `DELETE FROM audit_events WHERE occurred_at < ?` at `AUDIT_RETENTION_DAYS = 90`, hard (no soft-delete column), and also on a 6-hour timer. No export route exists. A rebuild explicitly does **not** drop `audit_events` (`rebuild.server.ts:40-44`), and NFR18's five categories are each pinned by `app/server/audit/audit-coverage.server.test.ts`. MET (one literal deviation — §3/U10).
- **FR36 / NFR13 rescan and rebuild** — three audited, cooldown-limited surfaces (board rescan, org-admin store rescan, org-admin rebuild) plus `npm run rescan` and a boot rescan; rescan reconciles by content hash while rebuild drops and re-projects. Non-corrupting **by construction**: a grep for every write primitive across non-test `app/server/projections/*.ts` returns zero hits, and the rebuilder imports only `existsSync, readdirSync, readFileSync`. MET.
- **PRD MVP anti-noise guardrails (all five)** — meaningful-comment, operator brevity, no-duplicate-summary, compression-threshold, evidence-separation all implemented in `app/server/tasks/comment-guardrails.server.ts` with co-located tests. MET.
- **UX spec §Additional Patterns default filters** — "needs me, blocked, waiting on human, and degraded continuity". The board now ships `all · human (Waiting on me) · agent · risk (Blocked or waiting) · quiet · continuity (Degraded continuity) · archived` (`app/features/board/board-filters.ts:7-92`). The continuity filter landed in pass 20 (D4). MET, with the "waiting on human" scope narrowing sanctioned by ruling 10/R8-3.
- **Ruling 64 (R19-10) components** — Continuity Recovery Panel (`app/features/task-detail/continuity-recovery.tsx`) and board keyboard traversal (roving tab stop, `app/features/board/board-page.tsx`, `role="listitem"` lanes) both exist. MET (their *state set* is H2's separate hold).
- **Ruling 66 (R19-12) gates** — the systematic both-theme contrast sweep and the no-control-hidden-at-any-width checks are real describes in `app/app.css.test.ts`, not enumerations. MET.
- **Pass-20's own list** — D1/D2(visual half)/D3/D4/D5/D6/D8/D9/D13 and C1–C14 were each re-verified in code at HEAD and all landed. Notable confirmations: the board renders the **one shared** `AcceptConfirm` (`board-page.tsx:50, 909, 948`), the board has an `aria-live` status region (`board-page.tsx:1945`), the readiness pill falls back to a neutral **"unknown"** instead of greenwashing to `ready` (`app/ui/pill.tsx:78-86`), live-obligation pills are withdrawn on accepted/merged as well as archived (`task-main-sections.tsx:150-160`), and the toast-honesty and copy-ban scanners exist as real suite gates (`app/features/toast-honesty.test.ts`, `app/features/copy-ban.test.ts`). Two residuals are filed in §3.

---

## §2 · Deliberate divergences with a sanction already in place

These are **fine**. Listed for awareness so the next pass does not re-file them as
defects. "In place" = the PRD or UX spec carries the amendment note itself;
"decisions.md only" = the divergence is sanctioned by a ruling but the requirement
text still reads the old way, so a reader of the PRD alone gets the wrong
impression.

| # | Canon statement | What ships | Sanction | Recorded in place? |
|---|---|---|---|---|
| 1 | **FR5** — "Admin users can create and configure governed delivery projects" | Creation is self-serve for any authenticated user; the creator is seeded project **admin**; `create-project` consults no org role (`app/routes/_index.tsx`, pinned by `app/features/shell/workspace-routes.server.test.ts`) | PRD FR5 amendment (2026-08-06), promoted under ruling 44 | Yes |
| 2 | **FR7** — repo default "and allow task-level overrides" | One repo per project; the override toggle and its copy were deleted | PRD FR7 amendment (2026-07-25) | Yes |
| 3 | **FR11** — tasks created by users "and authorized agents" | Human-only creation; an agent routes a decision packet instead. **Additionally** new tasks may only be created at the **entry stage** | PRD FR11 amendment (2026-07-25); entry-stage rule is **ruling 70** (R19-14) | FR11 yes; **entry-stage rule decisions.md only** |
| 4 | **FR14 / FR20** — "one primary specialist and additional consultant specialists" | The uniform `engagements[]` model (see §0) | PRD FR14/FR20 amendment (2026-08-04) | Yes |
| 5 | **FR27** — "transition to `done` … human-authorized" | Four sanctioned endings (see §0) | rulings 2, 40, 43+62, 59, 77 | Yes — FR27 carries the amendment notes |
| 6 | **FR27** — acceptance is verdict-gated | A **project member's GitHub PR approval**, bound to the delivered commit and failing closed, satisfies the verdict gate (`app/server/github/pr-human-approval.server.ts`) | **ruling 68** (R19-B) | **decisions.md only** — FR27 still describes no human-approval path |
| 7 | **FR31** — branch/PR creation tied to the review stage | Delivery is an **operator decision**; human delivery button is the escape hatch; a review stage with no PR writes a typed event | **ruling 21** (R15-2) | Yes |
| 8 | **FR4** — commenting "app-wide … including projects they are not a member of" | Projects are **members-only**; a non-member gets a 404-equivalent on every project surface | **ruling 25** (R15-4) | Yes |
| 9 | **FR33** — "preserve an auditable history" | 90-day hard delete by a boot-time retention pass; no export in V1 | PRD FR33 bounding note (2026-07-25) | Yes |
| 10 | **FR8** — admins "define separate human access policies (RBAC) … for each project" | Per-project *role assignment* is real; the action→role **grant matrix is instance-wide and read-only**, single-sourced in `app/shared/rbac.ts` and rendered (not edited) by the Policy page (`app/features/policy/policy-page.tsx:101, 214`, `policy-data.ts:11-21`) | **ruling 2** (amended) | **decisions.md only** — FR8 reads as if the matrix were project-definable |
| 11 | **NFR1–NFR4** — four numeric latency targets | All struck, replaced by qualitative requirements; no performance harness exists | **ruling 63** (R19-9) | Yes — §Responsiveness rewritten |
| 12 | **NFR14** — "surfaced … within 10 seconds of detection" | The surfacing ships; the stopwatch figure is struck | **ruling 63** applied by pass 20 | Yes — the note landed (this was pass-20's D13.2) |
| 13 | **NFR8** — separate permission boundaries "on every governed action" | **MCP server grants sit outside the capability matrix**: granting a server *is* the authorization for its tools, so a withheld `execute-code-or-write-repo` does not bound a granted server's write tools | **ruling 39** (R16-5) | Yes — the missing amendment note landed at `prd.md:278` (this was pass-20's D13.1) |
| 14 | **UX spec §Design System / §Color / §Typography** | `app/app.css`'s `:root` is the only token source: Manrope / Noto Sans / JetBrains Mono, `#5b76fe` accent, violet agent tint, radius card 16 / panel 22 | UX spec notes N19-2, N19-4; decisions.md §UI porting rules | Yes |
| 15 | **UX spec §Spacing & Layout** — 8px scale, 12-column grid, elevation scale | None of the three; per-component rem values and three named shadow tokens | UX spec superseding note | Yes |
| 16 | **UX spec §Responsive** — three capability modes, review-first below 768px | **One surface, reflowed**; nothing gated on viewport; the two contracts became suite gates | PRD amendment (2026-07-25) + **ruling 66** (R19-12) | Yes |
| 17 | **UX spec §Additional Patterns** — attention filter | Labelled **"Blocked or waiting"**, selecting `blocked` + `inconsistency_risk_detected` + `input_required` + failing validation + urgent + closed PR. Two chips the canon never named also ship: **"No activity"** (quiet) and **"Degraded continuity"** | **ruling 36** (R16-2) for the rename; D4 (pass 20) for continuity | **decisions.md only**; the quiet/continuity chips are recorded in neither |
| 18 | **UX spec §Journey / §Navigation** | The Review queue is a **triage list** — rows say "Review", deliberately not "Accept" | **ruling 30** (R15-11) | decisions.md only |
| 19 | **decisions.md ruling 15** — creation templates | "Lightweight · 3 stages" deleted; **Standard · 5 stages** is the only template | ruling 15 (narrowed) | Yes (in the ruling) |
| 20 | **One governed skills channel** | Claude uses the SDK's native skills mechanism; **Codex keeps prompt-text injection** — a disclosed asymmetry | **ruling 51** (R18-5) | decisions.md only |
| 21 | *(no canon statement — a whole shipped capability)* | `use-browser` agent capability (default off, MOUNT-enforced on both backends, requires effective egress), a viberr-owned Playwright MCP server, chromium in the app image, and task `attachments/` with a member-only route | **ruling 75** (R19-19) | **decisions.md only — the PRD and the UX spec do not mention a browser capability, attachments, or evidence files at all** |
| 22 | **NFR8 / capability matrix** — specialist modes | `recommend` is dropped for the specialist kind: specialists act **directly** or are **withheld**; the seed writes `direct` | **ruling 81** (R20-6) | decisions.md only |
| 23 | **NFR6** — "All authenticated application traffic … must be encrypted in transit" | The app enforces nothing at its own layer: no TLS termination, no https redirect, no HSTS, no `trustProxy`. `react-router-serve` speaks plain HTTP and `compose.yml` maps the port with no proxy. Outbound *is* encrypted by construction (`GITHUB_API_BASE` hardcoded to `https://api.github.com`, git remotes `https://`, provider SDKs at HTTPS defaults) | `docs/operations/deployment.md:41-77` states it plainly — Viberr must sit behind a TLS-terminating reverse proxy, "Encryption in transit is the deployment's responsibility, not the Node process's", and HSTS/certs/redirects "belong to the proxy layer"; `docs/architecture/decisions.md:656` agrees | **Yes — in the operations docs.** The rare case where docs and code match exactly. The PRD itself carries no note, but the requirement is honestly discharged elsewhere. One real hole remains — §3/U8 |

**Awareness note.** Rows 3, 6, 10, 17, 18, 20, 21 and 22 are all sanctioned by a
ruling but invisible to a PRD-only reader. Row 21 is the largest: an entire agent
capability, its deployment weight (~700MB of chromium in the image) and a new
canonical `attachments/` directory exist in the product and in no planning
artifact. Ruling 44 (R17-3) promoted FR5's divergence into the PRD for exactly
this reason; whether the same treatment is owed here is an owner call, not a
defect.

---

## §3 · UNDOCUMENTED divergences — no amendment note, no ruling

**This is the critical list.** Each item is app (or repo) behaviour that
contradicts a canon statement, with no amendment note in the canon document and no
sanctioning ruling in `docs/architecture/decisions.md`. I checked all 83 rulings
for each one.

One exception by design: **U2 is a clean result, not a finding.** It records an
audit that was performed and what it cleared, because the alternative — saying
nothing about the largest recent change in the tree — leaves the next pass to
re-open the same question with no record of what was already checked. Ordered
roughly by severity, with U2 kept beside U1 because both concern the same two
post-pass-20 commits.

### U1 · The lint toolchain contradicts architecture.md twice, in a sentence that says "by decision" — HIGH

**Canon.** `planning/planning-artifacts/architecture.md` — which
`docs/architecture/decisions.md` names as the document that "wins on conflict" —
states it twice, unambiguously:

- §Development Workflow Integration, line 955: *"CI runs two jobs: `verify`
  (typecheck → unit/integration tests → production build) and `e2e` … **there is
  no lint step, by decision**."*
- §Enforcement Guidelines, line 587: *"Enforce through typechecking, tests, and
  review against this architecture document. **There is no linter** (see CI/CD
  above), so none of the naming, module-boundary or dumping-ground rules is
  machine-checked — a reviewer is the only gate."*

**What ships at HEAD.** Commits `54ffab8` and `ce2bc9e` (2026-08-19, after the
pass-20 merge) installed a linter and applied it across the tree:

- `.oxlintrc.json` — 15 vendored `anti-slop` rules, **every one at `"error"`**.
- `tools/oxlint/anti-slop/` — 21 tracked files, a vendored third-party plugin.
- `npm run lint` in `package.json`.
- `ce2bc9e` rewrote **387 files, +13,361 / −7,734 lines** to satisfy those rules —
  replacing hand-rolled decoders with zod schemas, deleting type assertions, and
  converting 31 of 33 `vi.mock` module mocks into production-code injection seams.

There is **no amendment note in architecture.md**, **no ruling in decisions.md**
(the file still ends at 83 / R20-8), and **no mention anywhere in `docs/`,
`CONTRIBUTING.md`, `README.md` or `FILES.md`** — `grep -rln "npm run lint\|oxlint"`
over all of them returns nothing.

**Why it matters, beyond the missing note.** The gate does not work as a gate:

1. **`npm run lint` is red on a clean tree.** Running it at HEAD emits 26
   findings — **25 at `error` severity**, 1 warning — and **exits 1**
   (`app/server/secrets/git-output-redact.server.ts:137`,
   `app/server/runtimes/wire-format.server.ts:221`,
   `app/features/task-detail/timeline.tsx:73`, `test-support/setup-dom.ts:7`, …).
   The commit message says these 26 "remain by decision" — but that decision is
   recorded only in a commit message, with **no `.oxlintrc.json` suppression, no
   allowlist and no severity downgrade**, so a contributor who runs the script
   cannot tell an accepted finding from a new one. That is the same "rule with
   violations and no check" failure D5 was filed for, one layer up.
2. **It is in no gate.** `.github/workflows/ci.yml` runs typecheck → test → build
   in `verify` and Playwright in `e2e` — no lint step. `CONTRIBUTING.md:52-63`
   ("Running the test suite") lists exactly four commands — `npm run typecheck`,
   `npm test`, `npm run build`, `npm run e2e` — and then reasons about "the other
   three", so the list is closed by construction and `npm run lint` is not in it.
   The tree was reshaped by 387 files to satisfy a rule set that nothing enforces
   going forward.
3. **The 387-file rewrite is unaudited against the rules the canon *does* set.**
   architecture.md line 575: *"Tolerant parsing must still emit explicit
   diagnostics; **silent parse fallback is forbidden**"*, and its Anti-Patterns
   list names *"Hiding parse failure with silent best-effort fallback behavior"*.
   Zod's `.catch()` — which the commit message says it adopted per-field — is
   precisely a silent best-effort fallback. See U2.

**Ask the owner.** Three separable questions: (a) amend architecture.md's two
"there is no linter, by decision" statements and record the reversal as a ruling;
(b) make the script honest — either drive the 26 to zero, encode them as
justified suppressions, or drop the script; (c) decide whether lint joins CI's
`verify` job, and put the answer in `CONTRIBUTING.md`'s gate list either way.

### U2 · The 387-file refactor is unreviewed against the canon rule it most risks — spot-audit result: no drift found at the boundaries that matter

**Canon.** architecture.md §Retry and Recovery Patterns, line 575: *"Tolerant
parsing must still emit explicit diagnostics; **silent parse fallback is
forbidden**"*, echoed in its Anti-Patterns list (*"Hiding parse failure with
silent best-effort fallback behavior"*) and in `decisions.md` §Behavior rules
(*"malformed input produces diagnostics plus a readiness downgrade … never a
silent drop"*).

**Why this needed checking.** `ce2bc9e`'s own message says it replaced
"hand-rolled typeof decoders" with "tolerant zod boundary schemas (**per-field
`.catch`**, truthiness-guarded fields as `.min(1)`, **strip semantics**)". Zod's
`.catch()` *is* a silent best-effort fallback, and `.strip()` drops unknown keys —
which on a canonical, hand-editable `task.md` would mean the next write destroys
whatever a human put there. Nothing in the commit or the repo records that this
tension was considered.

**Spot-audit result at the boundaries that carry governance weight — clean:**

- **`app/schemas/task-file.schema.ts` / `project-file.schema.ts` — no tolerance
  change.** The diff introduces **no** `.loose()` → `.strip()` conversion in either
  file (`git show ce2bc9e -- app/schemas/task-file.schema.ts | grep '^[+-].*loose'`
  returns only an unrelated local variable rename), so unknown frontmatter keys
  still survive a read/write round trip. All but one of the 8 `.catch()` sites in
  `task-file.schema.ts` predate the commit and carry their own provenance
  (`P13-D-28`, `P14-LV-07`, `R17-1`) — they exist so a hand-edited garbage value
  nulls one field rather than the whole PR ref. The one **new** `.catch` is
  `evidenceCellSchema` (`:1327-1328`), which stringifies a non-string evidence
  cell instead of dropping the row — behaviour-identical to the decoder it
  replaced. `project-file.schema.ts`'s 196 changed lines are field-schema
  extraction, with no new `.catch` and no strip change.
- **Injection seams are not reachable from user input.** `TaskActionDeps`
  (`app/server/tasks/task-actions.server.ts:199-219`) makes `pushWorkspaceBranch`,
  `openTaskPr`, `mergeTaskPr` and `runOperator` overridable through `ctx.deps` —
  the four most consequential external effects in the product. Verified: **no
  route or feature action passes `deps`** (`grep -rn "deps:" app/` outside tests
  returns only server-internal factories), and no `ctx` is spread from a request
  body or parsed payload. The seams are test-only in practice.
- **The one governance-critical GitHub read the refactor made tolerant still fails
  closed.** `ce2bc9e` added
  `commit_id: z.string().nullable().optional().catch(undefined)`
  (`app/server/github/pr-linker.server.ts:163`) — and `commit_id` is exactly what
  ruling 68 (R19-B) binds a human PR approval to. A dropped value becomes
  `commitSha: null`, and the gate refuses on null in both places that read it
  (`pr-human-approval.server.ts:159-160` requires
  `commitSha !== null && commitSha === deliveredSha`; `:216` returns `null` when
  it is falsy). Fail-closed preserved.

**What is still open.** This is a *spot* audit of the highest-risk boundaries, not
a review of 387 files. The remaining exposure is the same one U1 names: a change
of this size landed with no review artifact, no ruling, and no gate that would
catch a regression in the rules it was reshaping the code around. The honest
disposition is to record the audit that was done (this entry) and decide whether
the rest wants one.

### U3 · A concurrent double-submit writes the same stage transition twice — NFR16 is enforced outside the file lock — HIGH

**Canon.** **NFR16**: *"The system must preserve idempotent behavior for external
execution actions so that retries do not create **duplicate official task
transitions**, duplicate branch records, or duplicate PR associations."*
`decisions.md` §Behavior rules: *"Mutating actions must be idempotent-safe
(idempotency keys or existence checks) — a retry must not duplicate transitions,
branches, PRs or events."*

**What ships.** `transitionStage` (`app/server/tasks/task-actions.server.ts`) does
the idempotency check **before** taking the file lock:

```ts
// :3130-3137  — OUTSIDE updateTaskFile's lock
const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
const fromStageId = existing.parsed.frontmatter.stage;
if (fromStageId === input.toStageId) {
  // Idempotent: already there.
  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}
```

and the in-lock mutator at `:3263-3302` then writes **unconditionally** — it sets
`parsed.frontmatter.stage = input.toStageId`, unshifts the "**Transition:** moved
… from X to Y" timeline entry, and `recordAudit("task.transition")` fires at
`:3312-3322` with no in-lock re-read. The acceptance path has the same shape (its
out-of-lock early return at `:6136`, and `acceptanceStageBlockedReason` returns
`null` when the task is already terminal, `:5549-5551`, so the in-lock re-check
cannot catch it either). Nothing in SQLite backstops it — there is no unique
constraint on transitions.

**What that costs.** A *sequential* retry is caught by the `:3134` guard, which is
why this has never shown up. A *concurrent* double-submit is not: a double-clicked
stage dropdown, a retried in-flight POST, or the operator racing a human all leave
**two "Transition" entries in the canonical `task.md` and two audit rows for one
human act**. That directly damages NFR18's promise — "reconstruct who initiated a
consequential action" becomes ambiguous for the single most consequential action
the product has.

**Why this is a *drift* and not just a bug.** The codebase already knows the right
pattern and writes it down, one thousand lines away, for a far less consequential
write — `recordDeliveredNextStep`, `task-actions.server.ts:4143`: *"Idempotent
(NFR16): the suppression re-runs **INSIDE the file lock**, so a retry, a second
delivery, or a concurrent operator recommendation can never leave two cards."* The
rule is understood; it just was never applied to the transition itself.

**Fix direction.** Re-read `parsed.frontmatter.stage` inside the `updateTaskFile`
callback and no-op the write (and suppress the audit) when it already equals the
target — the same shape `recordDeliveredNextStep` uses. Cheap, local, and
canaryable by racing two `transitionStage` calls in a test.

### U4 · Ruling **R20-9 is cited in shipped code and exists in no canon file** — MED-HIGH

**Canon.** Ruling 44 (R17-3): *"rulings live in `decisions.md`; a docs-canon
re-read is a required closing step of every pass. A ruling a code comment cites
but no canon file records is a ruling that gets reversed."*

**What ships.** `docs/architecture/decisions.md` ends at **83 = R20-8**. But
pass 20 produced **nine** owner rulings, and R20-9 is live in the product:

- `app/server/runtimes/operator-run.server.ts:2609` cites it by number, in the
  operator's triage-quality-gate prompt text;
- `app/server/runtimes/operator-prompt-mention.server.test.ts:77,82` is the test
  that pins it;
- its text survives only in `planning/discovery-2026-08-14-pass20/FINDINGS.md:754`
  ("Owner ruling 2026-08-15 (batch-2)"): *the operator MAY gather at triage an
  answer a goal delegated to the delivering agent's ask-human, BUT the packet must
  DISCLOSE that it is substituting for the delegated agent ask.*
- `planning/discovery-2026-08-14-pass20/VALIDATION.md:65` even asserts the
  promotion happened — "R20-1 … R20-9 (recorded in `docs/architecture/decisions.md`
  76–83…)" — while 76–83 is only eight slots.

This is a disclosure rule about timeline honesty living in a discovery ledger that
`planning/README.md` says is not retained. **Fix: promote it as ruling 84.**

**Lower-severity sibling.** Twelve older ruling ids are cited in `app/` and
resolve nowhere in `decisions.md`: `R6-3`, `R7-1`, `R7-2`, `R7-4`, `R7-5`, `R7-6`,
`R8-2`, `R8-4`, `R8-5`, `R8-6`, `R14-1`, `R14-4`. All predate ruling 44 (2026-08-04),
so they are not a violation of it — but a code comment citing `R14-1` today points
a reader at nothing.

### U5 · The New-task dialog promises a triage quality gate the server does not enforce — MED

**Canon.** **FR15**: agents flag underspecified tasks "and request human
clarification **before execution proceeds**."

**What ships.** The promise is made to the user, in the product, at the moment they
create a task. `app/features/board/board-page.tsx:1102`, the goal textarea's
placeholder:

> *"One or two sentences. **Underspecified goals get flagged at the triage quality
> gate.**"*

There is no such gate in the server (see §1/G4 for the full trace). The "triage
quality gate" is a string spliced into the operator's prompt
(`operator-run.server.ts:2596-2618`); an agent that raises `ask_human` is told by
the tool's own reply to *"Continue whatever does NOT depend on the answer"*
(`agent-toolkit.server.ts:316`); no transition and no agent dispatch consults the
open packet; and the two capabilities that name this behaviour are marked
"Advisory persona guidance (no runtime consumer)" in `app/shared/capabilities.ts:122`.

**Why it matters more than the gap itself.** §1/G4 is a missing feature; this is
the product **asserting** the feature to a user in a control's own copy. The
distance between "a gate exists" and "a well-worded instruction exists" is exactly
the distance ruling 63 struck four numbers for, and the same honesty standard
ruling 60 (R19-6) set for capabilities: refuse out loud rather than let a human
believe an authority exists.

**Ask the owner.** Enforce it (refuse a forward transition and an agent dispatch
while a triage-stage `input` packet is open — the machinery is all there), or
change the placeholder to describe what actually happens ("the operator reviews
scope at triage and will ask if it is unclear").

### U6 · Two thirds of the declared browser matrix have never been exercised — MED

Cross-filed from §1/G1 because it is a canon statement the product does not
honour and nothing records the gap. PRD §Web App Requirements names Chromium,
Safari and Firefox desktop; `playwright.config.ts:42-48` runs `chromium` alone and
CI installs only chromium. No pass has ever recorded a Safari or Firefox check.
Ruling 63's standing rule — a claim nobody measures is decoration, and the cost is
that it teaches readers the document's *other* claims may be decorative — applies
verbatim to a support matrix.

### U7 · The pass-20 fix for D2 corrected the visual order and left the assistive-technology order inverted, with the rationale recorded only in a CSS comment — MED

**Canon.** UX spec §Breakpoint Strategy, verbatim: *"the task detail's side-by-side
regions stack, **preserving reading order: current state, latest packet, next
action, then the timeline**."* Plus §Accessibility Strategy's WCAG 2.2 AA baseline
and §Implementation Guidelines: *"preserve hierarchy when stacking content: current
state, latest packet, and next action first."*

**What ships.** `app/app.css:4009-4024`, inside the single `max-width: 1100px`
block:

```css
.detail-side { flex-direction: row; flex-wrap: wrap; order: -1; }
```

with the comment: *"`order: -1` lifts the current-state/acceptance column ahead of
the timeline VISUALLY at this breakpoint while leaving DOM order untouched, **so a
screen reader still reads main → side** (UX spec §Breakpoint Strategy). A CSS
`order` swap is deliberately preferred over a DOM reorder here (cheap, no
markup)."*

Two problems with that:

1. **The comment cites the spec sentence as its authority while doing the opposite
   of what the sentence asks.** "main → side" *is* timeline-before-current-state.
   The spec's ordered list exists precisely to stop that order. So the AT half of
   D2 — which pass 20's own write-up called out ("the same source order is what a
   screen reader gets at *any* width") — is unfixed, and the code now reads as if
   it were a virtue.
2. **The CSS reorder creates a visual-order / focus-order mismatch that did not
   exist before.** Below 1100px a sighted keyboard user now sees Current state and
   the primary "Accept completion → Done" button at the top, and tabs to them
   *last*, after every timeline entry. That is the textbook WCAG 2.2 SC 1.3.2 /
   2.4.3 failure pattern, against a spec that makes WCAG 2.2 AA the baseline for
   core workflows — and the task page is the core workflow.

**No ruling covers this.** Ruling 80 (R20-5) put D2 in scope; the *choice between
the three fix options* pass 20 put to the owner (CSS `order`, DOM reorder, or
amend the spec) was made by the implementer and recorded only at the departure
site. §UI porting rules do require recording a deliberate departure in a comment —
which happened — but a departure from an explicitly ordered **accessibility**
contract is the class ruling 44 says belongs in `decisions.md`.

**Fix direction.** Either move `.detail-side` before `.detail-main` in the JSX and
use `order` to restore the desktop two-column arrangement (fixes both orders at
once), or amend the spec sentence to say visual order only and record why.

### U8 · `BETTER_AUTH_URL=http://…` silently downgrades the session cookie, with nothing to warn — MED

**Canon.** **NFR6** (encryption in transit), discharged to the deployment per §2/23
— but `docs/operations/deployment.md:41-77` discharges the *proxy*, not this.

**What ships.** Viberr never sets a cookie security flag itself; better-auth
derives `__Secure-` from whether `BETTER_AUTH_URL` starts with `https://`. Viberr
validates nothing about that value: the env var is `.optional()`
(`app/server/config/env.server.ts:48`) and `appOrigin()` accepts `http://`
(`:234`). So an operator who sets `BETTER_AUTH_URL=http://viberr.internal` gets
session cookies without the Secure attribute, in production, **with no warning
anywhere** — and, worse, that setting also removes the one accidental signal the
deployment doc documents as the symptom of a missing proxy (the `__Secure-`
login-loop). The failure is silent in both directions.

**Fix direction.** Reject a non-`https://` `BETTER_AUTH_URL` under
`NODE_ENV=production` in `env.server.ts`'s schema — a two-line change in the file
that already owns typed env validation — and optionally emit HSTS from the app so
the proxy layer cannot forget it.

**Adjacent, worth reconciling in the same pass.** `app/lib/auth.server.ts:213-214`
asserts *"Viberr ships without a reverse proxy… so there is no X-Forwarded-For"*
while `deployment.md` mandates one. Both are true of the *image*, but that premise
drives a real decision — disabling better-auth's IP-keyed limiter in favour of the
app-level `email|ip` bucket at `:222-227` — so a reader who trusts the comment
draws the wrong conclusion about what the deployment looks like.

### U9 · `FILES.md` claims to be generated from Git's index and is missing 52 tracked files — LOW-MED

`FILES.md:3`: *"Generated from Git's tracked-file index. Paths are grouped by
top-level directory."* At HEAD it has no section for **`tools/`** (21 tracked
files, all new in `54ffab8`), **`qa/`** (25) or **`test-artifacts/`** (6), and its
"Repository root" block omits **`.oxlintrc.json`** and **`compose.e2e.yml`**.
`planning/planning-artifacts/architecture.md` §Complete Project Directory
Structure (lines 627-646) has the same hole for `tools/` and `.oxlintrc.json` —
and that tree is the one decisions.md §Layout defers to as "regenerated from the
filesystem rather than restated here". A generated index that has not been
regenerated is worse than no index: it reads as authoritative.

`qa/` is at least *described* in architecture.md's tree ("fixtures/notes agents
produced during live QA passes"). **`test-artifacts/` is described nowhere**, and
its six tracked files are expired pass-20 validation residue — one-liners such as
`pass20-vib1.txt` ("pass-20 VIB-1 delivery loop OK") and `pass20-canaries.txt`
(the skill/KB/MCP canary tokens) written by live agent runs. They served their
purpose when pass 20 closed and are now permanent tracked source at the repo root.

### U10 · Two audit action kinds are retained forever, against FR33's own bounding note — LOW

FR33's 2026-07-25 bounding note says audit rows "are retained for **90 days** and
then hard-deleted by a retention pass that runs on every boot." The retention pass
exempts two kinds — `IDEMPOTENCY_AUDIT_ACTIONS = ["task.agent.replied",
"runtime.operator.plan_executed"]` (`app/server/db/retention.server.ts:49-52`,
excluded from the `DELETE` at `:81`) — because boot recovery uses their existence
as an idempotency key (`run-recovery.server.ts:221, 379`). The reasoning is sound
and recorded at the site; the PRD sentence is simply not true of those two, and it
is a *privacy-relevant* sentence (the note's whole point is that org- and
auth-scoped events "are genuinely gone at 90 days"). One clause in FR33 fixes it.

### U11 · A profile granted evidence but not verdicts has an evidence channel on Codex and none on Claude — LOW-MED

**Canon.** Ruling 51 (R18-5) sets the standard for backend asymmetry explicitly:
Codex keeping prompt-text skills injection is *"a disclosed asymmetry, not
silent."*

**What ships — and the reversal is the interesting part.** On **Codex**,
`collab.evidence` is an explicit member of the envelope-mount predicate:

```ts
// specialist-run.server.ts:1472-1475
const useEnvelopeSchema =
  backend === "codex" && realBackend &&
  (collab.verdict || collab.ask || collab.evidence);
```

and the comment above it (P13-D-26) states the reasoning exactly: *"without this
an evidence-granted Codex agent silently had no way to cite anything, making
attach-evidence-references a **Claude-only** capability the profile editor offered
to every backend."*

On **Claude**, the entire `report_outcome` tool — the only evidence channel that
backend has — is still nested inside `if (collab.verdict)`
(`app/server/tasks/agent-toolkit.server.ts:333`). So the fix P13-D-26 made for
Codex was never made on the side it was written to protect, and the asymmetry has
simply flipped: `attach-evidence-references` is now effectively **Codex-only** for
a profile that lacks `report-validation-verdict`. The seeded Reviewer holds both
grants, so no shipped configuration hits it; a hand-configured profile would,
silently, with the capability toggle showing green.

**Fix direction.** Hoist the evidence half of `report_outcome` out of the verdict
guard — one condition, mirroring the predicate Codex already uses — or disclose
the coupling in the capability-matrix UI the way ruling 51's asymmetry is
disclosed. The comment that already explains why is the test's own rationale.

### U12 · The Agents page still prints "specialist" in two rendered strings, on the same page that declares the word dropped — LOW

Pass 20's C11 fix landed for the group label and the create button
(`app/features/agents/agents-page.tsx:1274-1288, 1405-1410`), and the page's own
comment says *"The old 'specialist' vocabulary is dropped below so one object
stops carrying three names one click apart."* Two rendered strings on that same
page were missed:

- `:980` — engagement-table empty state: *"When an operator or **specialist** is
  running on a task…"*
- `:1377` — the stat label *"**specialists** in a working state"*.

The gate that should have caught it cannot: `app/features/retired-vocabulary.test.tsx`
bans the regex `/primary specialist/i` only, so the bare noun passes. FR14's
amendment makes *delivering* and *supporting* the shipped words. Small, but it is
the exact class rulings 54 and 57 name — a claim that lives in a comment is a
claim nobody re-derives.

### U13 · `planning/README.md` contradicts its own directory — LOW

`planning/README.md`: *"completed discovery passes and generated handoff ledgers
are **not retained here**."* `planning/` currently holds ten `discovery-*`
directories (pass 11 → pass 20), and this document adds an eleventh. Two of them
are load-bearing: R20-9's only surviving text is in
`planning/discovery-2026-08-14-pass20/FINDINGS.md` (see U3). Either the sentence
is wrong or the retention policy is. Given U3, the sentence should change.

### U14 · Pass-20's confirmation-tiering rule exists only in code comments — LOW

D6 asked the owner for the bar and proposed one ("anything that removes a person,
a stage, or a queued/pending action gets a confirm naming the outcome; everything
reversible and self-scoped stays one click"). Pass 20 implemented it — interrupting
a run and dismissing a recommendation now open confirms
(`app/features/task-detail/task-detail-page.tsx:303-308, 487, 554`), alongside the
stage/member/ownership/schedule paths — but ruling 80 (R20-5) only says pass 20
would fix the drift items; **the bar itself is written down nowhere in canon**.
The next surface that adds a destructive control has no rule to consult, and the
UX spec's §Button Hierarchy stops at "stronger confirmation language". One
sentence in decisions.md would close it.

---

## §4 · Summary

**Counts.** §1 — 4 requirements **HELD** by ruling 80 (R20-5), **6 open gaps** with
no disposition (G1–G6), and 13 verified-met checks. §2 — 23 sanctioned
divergences, of which 8 are recorded in `decisions.md` only and are invisible to a
PRD-only reader. §3 — **14 entries: 13 undocumented divergences plus U2, which is
a clean audit result recorded so the next pass does not re-open it.**

**The product surface is in good shape.** Every pass-20 fix was re-verified in code
at HEAD and all of them landed, including the ones with real teeth: the single
shared acceptance ceremony now rendered by the board, the autonomy-aware capability
display, the neutral `unknown` readiness fallback that stopped greenwashing, the
board's `aria-live` region and roving tab stop, degraded continuity projected onto
the card and the filter row, and two new suite-level scanner gates (toast honesty,
copy ban). The PRD's functional core is implemented end to end — file-native store
with a live watcher that catches externally *created* task directories, revision-
bound verdicts, four sanctioned completion endings, GitHub traceability, 90-day
audit retention, all five anti-noise guardrails.

**Read these five first.**

1. **U3 (HIGH) — NFR16 is enforced outside the file lock.** `transitionStage`
   checks "already at this stage?" before taking the lock and then writes
   unconditionally inside it, with no in-lock re-read; the acceptance path has the
   same shape. A concurrent double-submit therefore writes **two transition events
   into canonical `task.md` and two audit rows for one human act** — against NFR16
   by name and against NFR18's "reconstruct who initiated a consequential action".
   The correct pattern is already written down, and used, 1,000 lines away.
2. **U1 (HIGH) — a linter now exists and architecture.md says twice that it does
   not, "by decision".** `npm run lint` is red on a clean tree (25 errors, exit 1),
   sits in no CI job and no contributor doc, and the 387-file rewrite that
   satisfied it is the largest unreviewed change in the tree. Three separable
   decisions for the owner: amend the canon, make the script honest, decide whether
   it becomes a gate.
3. **U5 (MED) + G4 — the New-task dialog promises "underspecified goals get
   flagged at the triage quality gate", and no gate exists.** FR15's "before
   execution proceeds" clause is unimplemented on every path: `ask_human` tells the
   agent to keep going, no transition or dispatch consults the open packet, and the
   two capabilities that name the behaviour are marked "no runtime consumer". The
   product is asserting a governance feature in a control's own placeholder text.
4. **U4 (MED-HIGH) — ruling R20-9 is cited in a shipped operator prompt and its
   test and exists in no canon file.** Pass 20's own validation record claims it
   was promoted into `decisions.md` 76–83; that range holds eight rulings, not
   nine. Its only surviving text is in a discovery ledger `planning/README.md` says
   is not retained.
5. **G5 (MED) — FR28's live-progress rows are dead code.** `onPhase` is declared
   and wired but no adapter ever calls it, so the Live-run panel shows two blank
   rows while an agent works and the only way to see current activity is the raw
   console — the exact dependency FR28 forbids.

**Also worth the owner's eye:** U7 (D2's fix corrected the visual order and left
the screen-reader and focus order inverted, with a CSS comment that cites the spec
sentence it contradicts), U6 (Safari and Firefox are declared support and have
never been run), U8 (`BETTER_AUTH_URL=http://…` silently downgrades the session
cookie with no warning), G6 (runtime-provider credentials are process-global, so
NFR9's least-privilege claim holds for GitHub and not for the providers), and U11
(a green `attach-evidence-references` toggle grants nothing on Claude unless the
profile also holds `report-validation-verdict` — a capability card that overstates
authority, which is the F15-06 / R20-7 class one backend over).

**Method note for whoever acts on this.** Nine of the fourteen §3 items are
*documentation* fixes — an amendment note, a ruling, a regenerated index. Five are
code (U3, U5/G4, G5, U8, U12). The documentation half is not busywork here: ruling
44 exists because this project has already watched an unrecorded ruling get
reversed, and U4 is that failure mode reproducing on schedule one pass later.
