# Pass 27 — findings ledger (2026-08-24)

Status legend: 🔴 to-verify · 🟡 verified-real · 🟢 fixed · ⚪ owner-call/won't-fix
Sev: HIGH / MED / LOW / UX / Q(question)

Each finding must be VERIFIED against code before implementation. Reference docs in `reference/`.

---

## A. Codex/Claude parity (from ORCHESTRATION-PARITY.md code analysis — verify each)

### F27-P1 🔴 MED — Repo-write withholding is ADVISORY-ONLY on Codex, REAL on Claude
`execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch`, `open-review-pr` bind as Claude
`disallowedTools` denies but have NO runtime consumer on Codex (R22 removed the OS read-only sandbox;
"viberr is the sandbox"). So a profile that looks identically restricted in the capability matrix behaves
DIFFERENTLY per backend at the agent level. Server-side delivery gate is the real backstop.
Cite: app/shared/capabilities.ts CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS (~270-283), codex-runtime.server.ts.
QUESTION: is this a disclosure bug (matrix should mark these Claude-enforced-only for a Codex profile),
or accepted per R22? The matrix currently shows the same restriction for both backends. → verify + owner call.

### F27-P2 🔴 MED — Codex silently drops MCP server credentials with near-zero disclosure
codex-runtime.server.ts (~160-168) intentionally never forwards a decrypted org-MCP token to Codex (argv
visibility). Only surfaces in one narrow pre-flight branch (specialist-mcp.server.ts ~303-313). A server that
tolerates unauthenticated connections gives a Codex run silent ANONYMOUS access, with nothing in the persona,
run-input disclosure, or capability matrix saying the credential was dropped. → verify + decide disclosure.

### F27-P3 🔴 LOW — MCP tool-name casing diverges (Claude keeps hyphens, Codex lowercases)
Claude mounts `mcp__everything-http__echo`; Codex CLI rewrites to `mcp__everything_http__echo`
(codex-runtime.server.ts ~141-148, P13-LV-15). A skill/KB/persona naming a tool LITERALLY matches on one
backend, silently not the other. Transform is inside the codex binary — viberr can only DISCLOSE it.
→ verify; candidate: normalize references or warn when a granted tool name contains a hyphen.

---

## B. Minor UX / polish (from live UC-1/UC-2)

### F27-U1 🔴 UX — First run per project: long silent clone, no progress
First agent run on a new project does a full bare-mirror clone of the repo (akin-ozer/viberr = 161M, ~4 min)
behind "Preparing workspace · Cloning… first task" + elapsed, but NO progress bar. Later runs reuse the mirror.
Candidate: a clone-progress affordance or a "first run clones the repo, this is one-time" note.

### F27-U2 🔴 LOW — "pull_request:write unproven" stays stale after a successful PR open
Project GitHub page shows "pull_request:write unproven (verified on first use)" even AFTER the operator opened
PR #222 with that scope. The successful PR-open apparently doesn't flip the scope to proven. Mixed with the
adjacent "Every provable scope verified" line. → verify whether reconcile updates it; if not, flip on PR-open.

### F27-Q1 🔴 Q — Task keys reject digits (letters-only, 2-4)
New-project modal: "V27" → "Task key needs at least 2 letters." Only alphabetic keys allowed. Many trackers
allow alphanumeric (JIRA: letter-start, digits allowed). Deliberate? → owner call.

---

## Verified SOUND (not bugs — recorded to avoid re-checking)
- Run-concurrency gate (liveCount=handles+reserved; launch synchronous to handles.set; abandon/unavailable
  release+drain). No cap-bypass, no cap-blowing race. [code-verified]
- Insights math reconciles; "Completion rate" honesty (F26-3) live. [live]
- Full Claude lifecycle VQP-1: operator triage→deliver→PR→review→R15-1 disclosure→real merge #222. [live]
- Task metadata end-to-end (task.md ↔ board card ↔ Details panel ↔ ⌘K), both labels render (DOM-verified). [live]
- Q26-3 key-collision hint fires. [live]

---

## C. Operator subsystem (from OPERATOR.md code analysis — verify each)

### F27-O1 🔴 MED (test-coverage) — R26-1 (metadata→operator) has ZERO test coverage
The pass-26 "Triage signals (advisory)" prompt text + OperatorTaskSnapshot priority/labels/dueDate
propagation are asserted in NO test. A regression would pass the full suite silently. User invited
touching tests "in a critical way" → add coverage. Cite: operator-actions.server.ts get_task snapshot,
operator-run.server.ts prompt assembly. (Corroborated by pass-27 live notes.)

### F27-O2 🔴 MED — Codex operator plans are NON-TRANSACTIONAL
Operator-on-Codex = a schema-constrained JSON plan executed server-side AFTER the run (executeCodexPlan),
vs Claude's live mcp__viberr__* tool calls. A thrown mid-plan action aborts the remainder but does NOT undo
already-applied steps → e.g. a stage transition lands, then accept_completion fails right after, leaving an
inconsistent task. A stale run_agent(profileId) targeting a no-longer-current deliverer silently no-ops.
Cite: operator-run.server.ts executeCodexPlan / OPERATOR_PLAN_TOOLS. → verify + harden or disclose.

### F27-O3 🔴 MED — Operator Claude-toolkit vs Codex-plan-toolkit drift (two hand-maintained literals)
Claude toolkit (operator-toolkit.server.ts) and Codex plan tools (OPERATOR_PLAN_TOOLS /
OPERATOR_PLAN_TOOL_CAPABILITIES / executeCodexPlan in operator-run.server.ts) are INDEPENDENT literals with
no shared generator. Adding/removing an operator capability requires editing both by hand — a capability
present in one but not the other = silent per-backend operator divergence. → verify parity of the two lists.

### F27-O4 🔴 LOW-MED — Stranded-resume vs transition-re-trigger double-drive race (mitigated, not eliminated)
operator-run.server.ts ~701-707: the code comment documents a LIVE double-drive occurrence from this race;
the guard narrows the window but has no real synchronization point. → verify current state; assess if the
single-flight lease fully covers it or a real double-drive is still reachable.

### F27-O5 🔴 Q — Operator snapshot EXCLUDES structured verdict + full comments/logs
OperatorTaskSnapshot omits validation/verdicts[] structured fields and full comment/log history; the operator
infers review outcome from a 6-event, 1500-char-capped timeline window. Could mis-judge review state on a
noisy/long timeline. → verify; owner call whether verdict state should be explicit in the snapshot.

## Reference docs built (for implementation phase)
- reference/OPERATOR.md (365 lines) — operator lifecycle, snapshot contract, acceptance, Codex-plan vs Claude-tools.
- reference/ORCHESTRATION-PARITY.md (523 lines) — adapter abstraction, Claude/Codex realization, parity table,
  context-resource mounting, concurrency gate.
- reference/TASK-LIFECYCLE-RBAC.md (pending subagent).

## RBAC test setup
Users: arda@viberr.dev (u_-HFvE2n9C3d5, org admin), bora@viberr.dev (u_RDW3GQfv_1WS, org member).
Bora is NOT a member of QA 27 (1 member = Arda) → good for non-member secrecy test (routes must 404).

---

## D. Task-lifecycle / RBAC / acceptance (from TASK-LIFECYCLE-RBAC.md — verify each)

### F27-L1 🔴 MED — Twin hand-maintained acceptance-gate functions can drift
`acceptanceRefusalReason` (task-actions.server.ts — the actual accept action) and `acceptanceBlockReason`
(rebuilder.server.ts — feeds the review queue + decisions inbox "waiting on you") are SEPARATE function bodies
that must be kept in the same gate ORDER by hand. Only spot-check tests pin specific orderings, not full parity.
Same defect class as R20-7 (a prior display/runtime drift). Risk: the review queue/decisions inbox can say a task
is acceptable (or not) differently from what the accept action actually does. → verify parity + add a parity test
or unify. HIGH-value fix (single source of truth).

### F27-L2 🔴 MED — Capability-matrix DISPLAY vs runtime-repair asymmetry (execute-code-or-write-repo)
Runtime (specialist-tool-policy.ts `grantModes`) INFERS the headline `execute-code-or-write-repo` grant from
scoped delivery grants when the headline is absent; the display layer (agents-query.server.ts) has INDEPENDENT
absent-grant logic that never calls that repair. A profile written outside the standard save path can show
"withheld" on the capability matrix while the runtime actually GRANTS it → the matrix lies about enforcement.
→ verify + route display through the same repair (single source).

### F27-L3 🔴 Q — setTaskMetadata never triggers the operator (metadata is inert to orchestration)
`setTaskMetadata` deliberately never calls autoInvokeOperator, and R26-1 only makes priority/labels/dueDate
VISIBLE in the operator snapshot (advisory). So marking a task urgent/overdue gives NO mechanical priority boost,
no re-triage, nothing — it's a pure human board aid + advisory hint the operator may ignore. Matches pass-26 Q26-1.
→ owner call: is metadata intentionally inert to orchestration, or should urgent/overdue nudge the operator?

---

## E. Confirmed live bugs

### F27-B1 🟡 MED — retry_other_backend copy "the switch sticks, and later prompts follow it" OVER-PROMISES
VERIFIED (deep trace — NOT the display bug I first filed). The exec-profile card showing the PROFILE-primary backend
is BY DESIGN: task-query.server.ts:112-118 `withLiveAgentBackends`→`primaryRunBackend` and specialist-run:1158-1161
deliberately make the card + a new Run + the run itself all follow the LIVE deployment "so they cannot drift" and to
avoid "pinning the task forever." So "Delivering agent · Codex" (my codex-only-pinned profile) correctly = what a new
Run launches. NOT a display bug.
THE REAL ISSUE: the recovery option copy (task-actions.server.ts:3284) reads "Re-run the {role} on {alt} with a fresh
context. **The switch sticks, and later prompts follow it.**" The handler (task-actions:5893-5915) restarts the run
with a one-time `backendOverride` and writes the switched backend to the ENGAGEMENT SNAPSHOT (task.md). BUT
specialist-run:1172-1177 resolves backend as `override ?? live-deployment ?? snapshot` — the snapshot is used ONLY
when the profile is UNDEPLOYED. For a DEPLOYED profile (the normal case) later prompts follow the profile primary and
IGNORE the snapshot the retry wrote → "later prompts follow it" is FALSE. Worse: after retry-on-codex (because claude
was failing), the NEXT operator prompt reverts to claude (profile primary = the failing one).
→ FIX DIRECTION (owner call): (a) correct the copy to match reality ("Re-runs now on {alt}; later runs follow the
profile's configured backend"), OR (b) make the switch actually stick for deployed profiles (task-level backend pin
honored by specialist-run, or re-deploy). (a) is honest + safe; (b) changes recovery semantics. My live repro was
partly induced (codex-only pin), but the copy/behavior mismatch is real for any deployed profile.
Sev MED (honesty). Add a test pinning the resolved backend of a follow-up run after retry_other_backend.

### F27-B2 ⚪ LOW (induced) — Card backend follows live profile after a mid-task profile-backend swap (VQP-3)
Changing a profile's pinned backend mid-task made VQP-3's card show the NEW backend for OLD (other-backend) work.
Induced by an unusual admin action (editing the profile backend while a task is mid-flight). Likely same root as
F27-B1 (display reads profile not engagement). Low priority; fixing F27-B1 likely covers it.

---

## VERIFICATION RESULTS (adversarial subagents)

### Parity cluster (F27-P1/P2/P3) — VERIFIED
- **F27-P1** ⚪ REFUTED / BY-DESIGN — owner-ruled R22 (decisions.md #93). `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`
  (capabilities.ts:270-283), `resolveCodexSandboxMode` never returns read-only (codex-runtime:368-383, docstring says
  the asymmetry is deliberate + matrix-disclosed). Disclosed in 4 UI surfaces (capability-matrix-modal:122-170,
  agents-page:233-274, create-profile-modal:753-782, policy-page:322,371), canary test capabilities.test.ts:47-56.
  → DO NOT TOUCH. Already the minimal (disclosure) fix, shipped.
- **F27-P2** 🟡 NUANCED (minor, optional) — mechanism real + deliberate (F7-MCP1: Codex serializes MCP config into
  --config argv = ps-visible; specialist-mcp:43-49, codex-runtime:160-168). DISCLOSED at every ADMIN decision point
  (resource-rows:247-257 "auth: configured (Claude runs only · Codex mounts it unauthenticated)", create-profile-modal
  :972-985, capability-matrix-modal:237-240, resource-modals:340). ONE residual gap: the AGENT's OWN run prompt
  (specialist-run:2067-2076) is generic — never says the auth was dropped for this Codex run. Optional 1-line
  prompt disclosure. LOW priority.
- **F27-P3** ⚪ REFUTED / BY-DESIGN — vendor transform inside codex binary (codex-runtime:141-148); caveat shipped
  (capability-matrix-modal:246-254); zero shipped seed assets name mcp__ tools literally. → DO NOT TOUCH.

LESSON: the app (pass 26) is very mature — most "findings" are already disclosed/owner-ruled. Adversarial
verification is essential to avoid "fixing" correct behavior. Initial code-scan findings were accurate about
MECHANISMS but missed the existing disclosures.

### Operator cluster (F27-O1/O2/O3) — VERIFIED
- **F27-O1** 🟢 REAL → FIXED. Added tests: operator-actions.server.test.ts (operatorSnapshot carries non-default
  priority/labels/dueDate + a plain-task defaults canary) and operator-run.server.test.ts (system prompt carries
  the "# Triage signals (advisory)" note + "change no gate and grant no authority"). 184+ green.
- **F27-O2** ⚪ REFUTED as bug — abort-no-rollback is DELIBERATE + DISCLOSED (operator-run:2192-2209 posts a
  timeline note each time); every applied step is a valid shared-core mutation → resumable state, not corruption;
  the "stale run_agent silently no-ops" claim is WRONG (operatorRunAgent returns a narrated noop, operator-actions
  :2394-2406). No fix. (Optional future regression test for abort+disclosure — not added; not a bug.)
- **F27-O3** 🟢 no-drift-today → GUARDED. Both toolkits list exactly 12 governed actions matching 1:1 (verified).
  Added a parity test (operator-toolkit.server.test.ts) asserting buildOperatorToolkit's governed tools == 
  operatorPlanToolsFor for granted/mixed authorities. FOUND the one DELIBERATE divergence: with nothing granted,
  Claude builds an empty toolkit but the Codex plan enum can't be empty so it falls back to the full in-Viberr set
  (refused visibly by narrateRefusedActions) — pinned as a dedicated test. Guards future vocabulary drift (the same
  medicine F21-3 gave OPERATOR_READ_ONLY_DENIED_TOOLS).

### Acceptance/RBAC cluster (F27-L1/L2) — VERIFIED
- **F27-L1** 🟡 NUANCED → small fix. Predicates are SHARED (closedPrBlockedReason/verdictGateReason etc. imported by
  both); only composition/ORDER is hand-kept, and the relationship is doc-commented. Real gap: acceptanceRefusalReason
  has a THIRD gate (noChangeWorkRefusal, live GitHub probe) that acceptanceBlockReason lacks, and the latter's comment
  (rebuilder.server.ts:296-300) INACCURATELY claims "only two gates stay out". Impact is SAFE-DIRECTION (review queue
  over-cautiously shows a no-change task as not-ready; the accept action would close it — no false promise). Drift
  class bit twice before (UX19-3, decisions.server). FIX: correct the comment + a safe-direction regression test.
- **F27-L2** 🟡 REAL (empirically confirmed via probe) → FIX. The capability matrix DISPLAY shows
  execute-code-or-write-repo as "Not granted" for a scoped-only grant (create/commit/open-PR granted, headline
  absent — a hand-edited or non-standard-save profile) while the RUNTIME grants full repo-write (Edit/Write + git
  push). grantModes (specialist-tool-policy.ts:119-129) infers the headline; effectiveProfileView
  (agents-query.server.ts:331-372) does NOT — repairDeliveryGrants runs only at the interactive save, never at
  file-parse or runtime-read. Since task/project markdown is hand-editable canonical truth, both paths reach an
  unrepaired grant set → the matrix LIES to an admin about enforcement. FIX: route the display through the same
  inference (export grantModes or reuse normalizeDeliveryGrants) + a test asserting display == runtime for a
  scoped-only grant. **This is the pass's most significant confirmed bug.**
