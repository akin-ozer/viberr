# Viberr product intent — distilled for implementation agents

Sources: `design/prd.md` (authoritative PRD, amended 2026-07-04), `design/CONVERSATION-SUMMARY.md`
(design-mock decisions), `planning/planning-artifacts/*`, memory of prior sessions. Read this before
changing product behavior.

## The product in one paragraph

Viberr is governed AI software delivery for small teams: **agents are the native workers, humans
govern flow, review, and acceptance**. The task's markdown file is the canonical operating contract
(state, context, timeline, decisions, evidence). A dedicated **operator agent** coordinates each
active task; **specialist agents** (Developer/Reviewer/Tester/Advisor) do stage work; humans decide
at boundaries. GitHub is the execution surface: task-key branch → commits → PR → human-accepted merge.

## Non-negotiable invariants

1. **Files are canonical truth**; SQLite is a rebuildable projection (only users/sessions/secrets/
   audit/notifications are app-owned). Malformed files degrade to diagnostics, never crash.
2. **Human-only Done**: only a human accepts completion (merges PR + moves to done). The single agent
   exception: operator under `full` autonomy with `completion-for-acceptance: direct` — audited.
3. **Separate human RBAC and agent capability policy** (two surfaces, never mixed). Agent caps:
   direct / recommend / human / off. `ALWAYS_HUMAN`: merge-PR, transition-to-done, change-policy.
4. **Typed events over chatter**: important events (quality, transition, blocked, completion, policy)
   are first-class; anti-noise guardrails (meaningful-comment, operator-brevity, no-duplicate-summary,
   compression-threshold, evidence-separation) are product features (PRD explicitly calls timeline
   noise the #1 risk).
5. **Re-anchor rule**: any reactivated agent re-anchors on the canonical task file; provider-history
   loss degrades gracefully (Journey 4).
6. **Traceability**: task key ↔ branch ↔ commits ↔ PR must stay unambiguous (NFR15).
7. **Idempotency**: retries never create duplicate transitions, branch records, PR associations, or
   duplicate operator runs (NFR16). Single-flight operator lease per task.

## Workflow model

- Stages are project-defined (default 5: Triage/Ready/In Progress/Review/Done). Boundaries per
  transition: `auto` | `approval` (admin/maintainer) | `human`; review→done locked `human` in V1.
- Waiting state: `human` | `agent` | `none`; readiness: ready / input_required /
  inconsistency_risk_detected / blocked (derived, diagnostics can only worsen it).
- The operator: assigns primary specialist, summons reviewers, generates packets, appends typed
  events, compresses timelines (direct); recommends transitions/completion/owner changes (supervised).
  Packets = the governed intervention surface (Journey 2): observations + 2-4 options, one recommended.
- Human owner (FR37/38): per-task reviewer & acceptance authority, self-service take/release, admin
  can release anyone; tracked separately from agent assignment.
- Commenting is app-wide (FR4): every registered user may comment on any task; non-member comments
  visibly labeled. @mentions route to agents (@operator, @agent, @<specialist>).

## Deliberate design decisions (do not "fix" these)

- **Word "governance/governed" is BANNED in UI copy** → use Maintainer / Permissions / "managed".
- No email notifications in V1 (in-app only; don't even say "in-app"). Email prefs in schema are
  dormant by ruling 13.
- PAT-only GitHub auth (no GitHub App); scopes validated at connect-time only.
- OAuth users are whitelisted (email or Google domain), no invite emails. Local users get
  admin-driven password resets (no self-serve reset).
- Popup overlays over pages for profile/notifications/connection editing.
- Agent identity: angular violet glyphs (Codex=cpu, Claude=sparkle); humans round blue avatars.
  "waiting on you" (blue) vs "agent working" (violet pulse).
- Rejected in design iterations: AGENTS.md preview in profile modal, Duplicate-profile button,
  colored card accents/shadows, "Sessions & security" panel, addressee toggle buttons (mentions only),
  live/SSE topbar indicator, "inconsistency risk" label on cards, quality-gate settings panel.
- Board scrolls horizontally under ~1250px by design (narrow screens are review-first per PRD).
- Project creation is self-serve for ANY org member (product decision B, pinned by test).
- 4 project roles admin/maintainer/contributor/viewer (decision A); org roles admin/member only.
- Specialist capability enforcement is REAL (decision C) — disallowedTools deny even under
  bypassPermissions.
- Archive project = hide+separate only, not read-only enforcement (decision D, copy is honest).

## Product questions — ALL RESOLVED (owner decided; implemented)

1. **Advisor (consultant) profile redundancy** → ✅ REMOVED (decision A). The operator absorbs
   advisory duties (scope-clarification via packets); the reviewer covers quality. No consultant
   profile ships. (Later: Tester also merged into Reviewer — decision D1.)
2. **Skills/KB/MCP org registry vs disk duality** → ✅ disk is truth (decision C-sweep); org settings
   lists every disk dir via `buildResourceCatalog`, metadata layered from the table.
3. **Operator "Plan:" comments vs brevity** → ✅ fold plan into the action comment, one timeline entry
   per operator turn (decision E).

## Additional owner decisions (2026-07-11 shipped-build critical pass)

4. **Policy presets (strict/balanced/auto)** were cosmetic → ✅ WIRED to real governance (S1): strict
   human-gates the pre-work boundaries; auto runs the operator at full autonomy; review→done stays
   human-locked in all.
5. **"Accepted, merge-pending" PRs** → ✅ a "Complete merge" action finishes the real merge later (S2).
6. **Codex tool confinement** (Codex SDK ignores allowed/disallowed tools; enforcement is Claude-only)
   → 📎 DOCUMENTED as a known gap for the upcoming role-bindings work (S3; security deprioritized now).
