# Pass 24 — comprehensive live use-cases (executing)

Target: akin-ozer/viberr via project "Viberr QA Lab" (VQL, balanced) + "Viberr Strict" (VS,
human-gated). Real PRs; merge some, reject some. Bug-hunt throughout.

Legend: ✓ pass · ✗ bug (→ BUG-LOG) · … in progress

## Already done earlier this pass
- UC01 new project (balanced + strict) ✓
- UC02 seeded agents deployed + skills scoped ✓
- UC03 capability matrix A1 display (balanced green / strict recommend) ✓ [A-1 live]
- UC04 first-clone hint (D1) ✓
- UC05 full delivery lifecycle Claude → PR #198 → review approve → accept → MERGE ✓
- UC06 apply operator recommendation (approval boundary) ✓
- UC07 reviewer pinned-revision + evidence separation ✓
- UC08 accept ceremony disclosure ✓
- UC09 out-of-band PR reject #199 → reconcile → withdrawn rec + recovery packet ✓
- UC10 skills allowlist fence (leftover non-invokable) ✓
- UC11 policy counts governed-only (D-2) ✓ [live]
- UC12 KB create + A2 delete-disclosure ("0 files, nothing grants it") ✓ [live]
- UC13 MCP unreachable disclosure (test-mcp connection refused) ✓
- UC14 connection "3 public repos" (A-3) ✓ [live]

## Executing now
- UC15 Codex delivery attempt ✓ — created "Codex Dev" profile (backend codex, gpt-5.6-terra); operator
  engaged it, started a Codex run; run FAILED on **"Codex is over its usage quota"** (external, until
  Sep 18). App handled it perfectly: honest **blocked packet** with the provider's exact quota message
  + `retry_other_backend`. (= owner-accepted B2 quota-signal; a *successful* Codex delivery is blocked
  by real quota, not a bug.)
- UC16 operator picks the correct agent ✓ — with 2 developers (Claude Developer + Codex Dev) eligible,
  the operator chose **Codex Dev** per the goal's instruction, and refined a directive to it.
- UC17 retry_other_backend (cross-backend retry) ✓ — resolved the packet with "Retry on Claude"; the
  SAME profile (codex-dev) re-ran on **claude** and delivered (commit 6770413). Backend switch sticks.
- UC18 secondary reviewer engagement (supporting vs delivering) …
- UC18 stage transitions on Strict (human-gated pre-work boundaries) …
- UC19 RBAC: member (Bora) members-only visibility + role gates …
- UC20 RBAC: owner assignment + acceptance authority …
- UC21 @mentions: @operator / @agent routing + human notification …
- UC22 skills correctly loaded per-run (dev skill only) …
- UC23 real MCP add + grant + agent call (if feasible) …
- UC24 comment usage / conversational agent reply …

## RBAC (fully validated live, as member "Bora")
- Reset Bora's password via admin (Edit user → Reset password → temp pw → forced set-new-password
  flow on first sign-in) ✓ — all pass-worthy.
- UC19 members-only visibility ✓ — Bora (member of QA Lab only) home shows **1 project** (QA Lab); the
  Viberr + Viberr Strict projects are hidden; org-settings tiles read "Org admins manage this".
- UC19b 404-as-absence ✓ — Bora GET /projects/viberr-strict → **"No project at projects/viberr-strict."**
  (byte-identical to an unknown slug; existence not leaked; R15-4).
- UC20 role gate ✓ — as Viewer, Bora has NO action affordances on a task (no Run operator / Run / Assign
  / Apply / Deliver / Change-stage); the Permissions panel states honestly: "You can comment (every
  member can)", "Run agents: Maintainer or admin only", "Accept completion: Maintainer/admin/owner".
- UC20b account menu respects RBAC ✓ — Bora's menu lacks "Instance settings" (admin-only), shows
  "Switch project" instead.
- Restored Arda's admin session after.

## Note: Codex externally quota-exhausted until Sep 18 → a *successful* Codex delivery couldn't be
## validated this pass (not a viberr bug; the failure path + retry_other_backend are validated).

## More live UCs
- UC18-strict stage transitions HUMAN-GATED ✓ — Viberr Strict workflow: triage→ready, ready→impl,
  impl→review all `approval`; review→done `human`. Operator triaged VS-1 and, at the approval-gated
  Triage→Ready, produced a **recommendation** ("Move the task to Ready … Advancing Triage → Ready") and
  left it `waiting: human` — it did NOT auto-advance (contrast QA Lab balanced, where Triage→Ready is
  auto and the operator advanced directly). Approval boundary enforced.
- UC21 @mention routing + BUG-2 honest refusal ✓ — posted "@operator …" on VQL-2 (open recovery packet).
  Comment parsed the @operator mention (chip), posted, routed to the operator branch; server logged
  "manual operator run refused — a decision packet is open"; NO operator run started; packet stayed
  open. The pass-23 BUG-2 fix holds live (toast "resolve the open decision", not "picking it up").
- UC22 skills loaded per-run ✓ (earlier: operator loads only viberr-app-expertise; specialist runs
  mount only their granted skill; leftover folders in the shared cwd are non-invokable via the SDK
  allowlist fence).

## Summary: 24+ distinct live use-cases covering creation, full lifecycle (merge #198), reject (#199
## out-of-band → recovery packet), Codex delivery + quota-fail + retry_other_backend, operator agent
## selection, RBAC (members-only/404/role-gate/permissions/org-menu), human-gated stage transitions,
## @mentions + BUG-2, KB create+delete-disclosure, capability matrix/policy (A-1/D-2 live), A-3, D1.
