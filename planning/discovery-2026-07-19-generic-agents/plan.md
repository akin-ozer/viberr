# Generic agents — design + implementation plan (2026-07-19)

## Intent (owner, verbatim distilled)

Apart from the operator, all agents (built-in and custom) are **generic**: one uniform
machinery, differentiated only by per-profile data — instructions, description,
MCPs/skills/KBs, backend. Capabilities are **uniform and granted**, not baked into a
kind: commenting, positive/negative outcomes (verdicts), decision packets,
ask-human-question tools, RBAC treatment. The **operator picks the right profile by
scanning descriptions and capabilities**. Motivation sharpened by VIB-12: the
reviewer-comment codec bug survived because the reviewer had its own code path and
its own identity conventions that no dev run exercised.

## Owner rulings (2026-07-19)

| # | Question | Ruling |
|---|----------|--------|
| G1 | Task attachment model | **Engagements list.** `task.md` gets one `engagements[]`; each entry = {profileId, backend, role}. Exactly one engagement carries `delivers: true` (workspace/PR ownership — preserves single-writer invariant + rework semantics). Reviewer stops being a slot. |
| G2 | Verdict power | **Full gating via grants.** Any verdict-capable agent writes `validation`; failing blocks acceptance identically to today's reviewer. Blast radius controlled by grants (seed: only the reviewer profile). |
| G3 | Human channel | **Ask-human + comments.** Agents get capability-gated `post_comment` and `ask_human`; ask_human opens a question-type decision packet (open-only; resolution stays human/operator). Operator keeps exclusive open+resolve+recommend. Seeded profiles: both ON. |
| G4 | Outcome wire | **Envelope + fallback.** One structured outcome schema {summary, verdict?, questions?}; MCP tool on Claude, output-schema on Codex, ONE server-side handler. If a verdict-GRANTED agent finishes with no envelope, fall back to `classifyReviewerVerdict` regex (logged as heuristic). |

### Standing defaults (announced, not objected)

- Verdict/quality events **attributed to the acting agent**, not `{kind:"operator"}`.
- Actor refs become **profileId-keyed** (`agent:<backend>/<profileId>`) with a
  never-null compat decoder for legacy role-slug refs (task files are canonical).
- The decorative capability ids (`comment-on-task`, `report-validation-verdict`, …)
  are **promoted to real gates** (finally making the O-2 "descriptive richness" true).
- Profile carries **two text fields**: short scannable `desc` (operator selection) +
  long body persona (the run's system prompt); `agents/definitions/<id>.md` content
  migrates into profile bodies and the parallel file is retired.
- `recommend` capability mode stays **operator-only** (R7-5 stands).
- **One delivering engagement per task** is a structural invariant (single-flight
  workspace guard keys on it).
- Operator resolved **by kind**, not the `"operator"` id literal; >1 operator
  deployment is surfaced as a config error, not silently first-wins.
- RBAC human layer unchanged: `run-agents` + `manage-agents` already cover this.
- Reply + completion effects land in **one atomic task-file write for every agent**
  (the reviewer's atomic path becomes the universal path).

## Current state (investigation 2026-07-19, 8-reader workflow)

Full inventory in the workflow synthesis; anchors:

- Profiles are already data (kind, role, capabilities[{id,mode}], resources, body
  desc — `agent-profile-file.server.ts:26`) but **none of it reaches runtime**:
  `desc`/capabilities absent from `DeployedSpecialistView` (`specialist-run.server.ts:1545`),
  custom profiles run persona-less, capability ids for verdict/comment are decorative.
- Kind is a **closed enum** `operator|primary|reviewer` (`runtime-types.ts:25`)
  hardcoded at dispatch sites; `startSpecialistRun`/`startReviewerRun` are ~250-line
  twins (`specialist-run.server.ts:484/782`); operator dispatch + toolkit + plan enum
  + recommendations + UI all mirror the three-species world.
- Verdicts: regex-sniffed reviewer prose (`classifyReviewerVerdict`), written by a
  reviewer-only completion branch, attributed to the operator.
- Identity: timeline actors keyed backend+role-slug (root cause of VIB-12);
  `RESERVED_HANDLES` hardcoded; seed snapshots reviewer role as "Reviewer" while the
  profile says "Review & validation" (`demo-data.server.ts:438` vs `:231`).
- Test blindness (R12): punctuation-free fixtures, seed role mismatch, e2e never
  runs a reviewer — three shields that hid VIB-12.

## Target architecture

### Data model

- **Profile** (org template, `agents/profiles/<id>.md`): adds `desc` (short, one
  paragraph, for operator scanning). Body = long persona (system-prompt material).
  `kind` stays `operator|specialist` ("specialist" = generic agent; only the
  operator kind is special). Capabilities from the **unified catalog**.
- **Engagement** (task frontmatter): `engagements: [{profileId, backend, role,
  delivers?}]` replaces `specialist` + `reviewers[]`. `role` is a display snapshot
  taken from the live profile at engage time. Exactly 0..1 entries have
  `delivers: true`.
- **RunKind** — AMENDED during implementation: the stored enum stays
  `operator|primary|reviewer` as a **derived storage/grouping label**
  (`delivers ? "primary" : "reviewer"`); all BEHAVIOR keys off engagement data
  (`delivers` + capability grants), never off kind. Rationale: session resume,
  recovery filters, run projection and UI retry all key on the stored values —
  collapsing them buys no behavioral uniformity (already achieved) at real R5
  risk. `roleShort` now reads `run.kind`, never string-matches role labels.
- **Actor ref**: `agent:<backend>/<profileId>`. Decoder NEVER returns null for a
  well-formed `agent:` ref; unknown/legacy slugs decode to an agent actor with the
  raw slug as label (display resolves the profile name when the id matches).
- **Unified capability catalog** (`app/shared/…`): one catalog; each entry declares
  applicable kinds, valid modes, enforcement scope (both/claude-only/advisory),
  `promotable`. Absorbs `CAP_MODAL_CATALOG` + `OPERATOR_CAP_CATALOG` and the
  `completion-for-acceptance` string special-case.

### Runtime

- **One `startAgentRun(engagement, …)`** replaces the twins. Single-flight guard
  keys on `delivers`. Thread ids unify (`agent:` prefix; legacy prefixes accepted on
  resume).
- **Persona**: `buildAgentPersona(profile)` = profile body + skills + KB (24k budget
  as today). `agents/definitions/<id>.md`, if present, overrides (transition aid).
- **Agent toolkit** (Claude): scoped MCP server exposing, per grants:
  `post_comment` (comment-on-task), `ask_human` (ask-human → question packet,
  open-only), `report_outcome` (report-validation-verdict). Built with the
  operator-toolkit's capability-gated builder pattern; authority is per-capability +
  agent-attributed — never the `operatorAuthorized` boolean (R7).
- **Codex transport**: `outputSchema` = the same envelope; applied server-side after
  the run by the same handler. Capability enforcement asymmetry surfaced honestly
  per-grant (claude-only labels), consistent with S3.
- **Completion** (`applyAgentCompletionEffects`): de-kinded. One atomic write per
  completion containing: reply comment (guardrail-processed) + envelope effects
  (verdict event attributed to the agent + validation frontmatter) — then delivery
  reconcile iff `delivers`, packet-retry options profileId-stamped for all, operator
  react unchanged (depth cap covers tool-posted events — R3).
- **Verdict recording**: `recordAgentCompletion` — ONE atomic write per finished
  run (reply + verdict event ATTRIBUTED TO THE AGENT + validation + optional
  question packet); same state machine (`hasReworkSinceLastRejection` rework
  gate, acceptance blocking), fed by envelope or (fallback, verdict-granted
  only) regex. Rework detection identity-matches via the delivers-engagement
  profileId; role-regex fallback deleted (R4).
- **Verdict-grant transition rule** (AMENDED — G2 without breaking live data):
  an EXPLICIT `report-validation-verdict` grant is authoritative; an ABSENT
  grant defaults to `direct` on a NON-delivering engagement (exactly today's
  reviewer behavior — pre-grant deployments keep working) and `off` on a
  delivering one (a developer's "tests pass" prose can never flip validation —
  R1/R2). The seed now grants verdict explicitly to the reviewer only and
  REMOVED the developer's legacy `recommend` verdict grant (which coerced to
  direct and would have armed the R1 hazard).

### Operator selection

- `DeployedAgentView` gains `desc`, granted-capability summary, resources.
- Snapshot (get_task + Codex preamble) lists engaged agents + available profiles
  with desc/capabilities and instructs selection by them.
- Toolkit collapses six kind-tools → `engage_agent` / `run_agent` / `prompt_agent`
  (+ `disengage_agent`), param `delivers?: boolean`. Gates: existing operator
  capability ids kept, mapped (assign-primary-specialist governs delivers=true,
  summon-reviewers governs delivers=false engage/run) to avoid grant migration.
- Codex plan enum + scripted fallback updated; fallback picks by capability
  (deliver-capable for build stages, verdict-capable for review) instead of
  role regex + hardcoded ids.
- Recommendations: kinds re-cut to engagement shape (`engage_agent` carrying
  profileId + delivers), apply switch + all clearing sites updated (R11).

### Routes, mentions, UI

- Intents: `engage-agent` / `run-agent` / `disengage-agent` / `set-deliverer`
  replace assign/run-specialist + assign/run/remove-reviewer. RBAC action stays
  `run-agents` for all.
- Mentions: @handle resolves engaged profiles by profileId (name/handle match);
  mention of a deployed-but-unengaged profile engages it (delivers only if none
  exists). Session resume keys (profileId, taskKey, thread); recovery filter moves
  in lockstep (R5).
- UI — AMENDED scope: create-profile-modal gained the `desc` + persona split
  (D6, implemented). DEFERRED to a future design-language pass: renaming the
  task-page wire intents (assign/run-specialist, assign/run/remove-reviewer →
  engage/run/disengage-agent) and the execution-profile grid labels, plus
  profile-name resolution for agent chips — all purely presentational; the
  machinery beneath (startAgentRun, engagements, generic operator tools) is
  already generic. Rationale: wire-name churn buys no behavioral uniformity
  and the canonical `design/` mock should drive the visual rework.

### Seed, tests, e2e (the R12 answer)

- Seed + base template: `developer` (deliver+comment+ask), `reviewer`
  (verdict+comment+ask), personas in profile bodies, descs written, role snapshots
  taken from live profiles (kills the demo-data:438 mismatch class).
- Test fixtures instantiate agents **from the real seeded profiles** (punctuated
  roles included) — never hand-rolled punctuation-free ones.
- Unit: envelope handler (verdict/questions/fallback), engagement schema
  round-trip, compat actor decode, unified catalog invariants (ALWAYS_HUMAN
  coercion, non-promotable), single-deliverer invariant, atomic reply+effects.
- e2e: drive an engaged verdict-capable agent through completion (04-runtime gap).

## Phases (each lands typecheck+suite green, committed separately)

1. **Foundations**: unified capability catalog; profile `desc`; actor-ref
   profileId codec + compat decode; engagement schema + task-file parse/serialize;
   RunKind `operator|agent` (+legacy read mapping).
2. **Pipeline**: `startAgentRun` merge; persona from profile body; RunSpec carries
   promptMode/denies/sandbox as data (adapters go kind-blind); envelope schema +
   `applyAgentOutcome`; agent toolkit MCP (Claude) + Codex outputSchema; de-kinded
   completion with universal atomic write; `recordAgentVerdict` + fallback.
3. **Operator**: DeployedAgentView desc/caps; snapshot + prompts; toolkit tool
   collapse; Codex plan enum; scripted fallback by capability; recommendations
   re-cut.
4. **Routes + mentions**: new intents; mention/resume/recovery rekeying; rework
   detection via delivers-profileId.
5. **UI**: ExecutionProfile engagements list; runs panels; profile editor (desc,
   persona, unified catalog); actor display names.
6. **Seed + tests + e2e**: seeded grants/personas/descs; fixtures from real
   profiles; new unit + e2e coverage; docs.
7. **Adversarial review**: multi-agent workflow vs risks R1–R12; fix confirmed
   findings; docker bind-mount live verification (engage generic agent + reviewer
   verdict + ask-human packet end-to-end).

## Implementation status (2026-07-19)

Phases 1, 2a, 2b, 2c, 3, 5 landed (commits on `generic-agents`); phase 4 (route
wire-name renames) + the UI rework deferred to a design pass — the machinery is
already generic. Full suite green (1370); typecheck clean.

**Adversarial review (2-round, 6 dimensions, adversarial-verify per finding).**
8 confirmed findings, all fixed:
- R2 HIGH — legacy `report-validation-verdict: recommend` on the DELIVERING
  developer coerced to `direct`, arming verdict-veto on live pre-branch data.
  Fix: `recommend` is treated as non-explicit (falls through to the
  delivers-based default → OFF for a builder).
- MEDIUM — editor round-tripped an absent verdict grant into an explicit `off`,
  revoking a pre-branch reviewer's verdict on cosmetic save. Fix: seed the
  toggle from the effective mode via a delivery heuristic.
- MEDIUM ×3 (one root) — assign paths could duplicate a profileId in
  engagements[], corrupting run routing. Fix: dedup on promote, no-op on
  re-engage, + parser profileId-uniqueness backstop.
- MEDIUM — mid-run post_comment corrupted the no-progress guard. Fix: the prior
  reply must predate this run's start.
- LOW ×2 — enforcement labeling for the 3 collaboration ids; packet `from`
  leaked the raw actor-ref codec string. Both fixed.

**Docker live-data verification** (bind mount seeded pre-branch, deterministic
tsx check against branch source): all 14 legacy-format task files absorb into
engagements with ZERO dropped timeline events and zero corruption diagnostics;
the developer's legacy `recommend` verdict grant resolves to verdict OFF (R2
disarmed) while the reviewer resolves to verdict ON (behavior preserved).

## Risk register (from investigation; mitigation owner = this pass)

- R1 regex-on-everyone: fallback ONLY for verdict-granted profiles.
- R2 verdict veto creep: seed grants verdict to reviewer only; grant UI shows the
  gating consequence.
- R3 react amplification: depth cap + verbatim guard must cover tool-posted
  events; packet-retry profileId-stamping normalized.
- R4 rework laundering: identity via delivers-engagement profileId; delete role
  regex.
- R5 session/recovery continuity: resume + recovery rekey in the same commit as
  the kind collapse.
- R6 on-disk compat: never-null agent-ref decode; legacy engagement frontmatter
  (`specialist`/`reviewers`) parsed into engagements on read, written back in new
  form.
- R7 authority: per-capability agent authority + agent attribution; the
  `operatorAuthorized` boolean is never handed to agent tools.
- R8 Codex honesty: per-grant claude-only labeling.
- R9 invariants: ALWAYS_HUMAN coercion + completion-for-acceptance non-promotion +
  operator can't bare-transition to Done — preserved in the unified catalog.
- R10 guardrails: agent comment tool uses the agent guardrail set explicitly.
- R11 recommendation clearing: all sites updated with the kind re-cut.
- R12 test blindness: fixtures from real seed profiles; e2e drives an engaged
  agent.
