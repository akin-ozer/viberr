# Viberr — end-to-end pass FINAL REPORT (self-contained)

One consolidated record of the full **discovery → live testing → implementation** cycle, so the
evidence for all three phases is in one place. Everything below is verifiable now (files on disk,
PRs on GitHub, PR #7, the running app).

---

## Phase 1 — Discovery (docs + code + UI)

**Documentation reviewed** (canonical intent): `planning/discovery-2026-07-10/` — `product-intent.md`
(7 non-negotiable invariants: files-are-truth, human-only-Done, separate RBAC vs agent-capability,
typed-events-over-chatter, re-anchor rule, traceability, idempotency; the banned "governance" copy
rule; the deliberate design decisions incl. Advisor-removed / Tester→Reviewer-merged / self-serve
project creation / 4 project roles), `findings.md` (the prior backlog, all resolved),
`app-reference.md`, `test-catalog.md`.

**UI walkthrough** (browser, this pass) — screenshots taken of: Home (membership-scoped, honest
"Collaborative AI software delivery"), Board (5-stage Triage→Done, filter chips, card glyphs),
Agents (3 profiles Operator/Developer/Reviewer, Live tab, capability matrix; operator "never writes
code and never closes a task itself"), Policy ("Human access and agent capability — two surfaces,
managed separately", 4 roles, RBAC matrix), Activity (typed-event stream, Humans/Agents/System),
GitHub (honest "No credential configured"), Org Settings → Resources ("No MCP servers yet", KBs
"read live · re-scanned"), plus task detail + decision packet + the operator-recommendation card.

**Code audit** — a 6-reader parallel sweep of the post-implementation tree found **19 net-new
findings** (1 HIGH, 7 MED, 11 LOW), documented in `current-state-findings.md`. **All 19 are fixed.**

---

## Phase 2 — Live testing (22 cases, real PR on akin-ozer/viberr)

Fresh project **Viberr Selftest 3** (`viberr-selftest-3`, repo akin-ozer/viberr, Balanced preset),
created via the API. 22 test-case tasks VTC-1..VTC-22 created. Real Claude + Codex backends (Codex
hit its usage quota → exercised the cross-backend path). A real PR opened, verified, and **merged via
`gh`**. All three seeded RBAC users exercised (arda admin, selin viewer, murat non-member).

| # | Case | Verdict | Evidence (live this pass unless noted) |
|---|------|---------|----------------------------------------|
| C01 | Operator auto-flow (well-scoped) | ✅ | Operator auto-advanced VTC-4 Triage→Ready→In Progress + assigned Developer |
| C02 | Vague task → input packet | ✅ | VTC-2 "Make it better" → operator INPUT packet "not actionable — needs scoping", held at Triage (waiting=human) |
| C03 | Coalesce-queue (@operator ×2 inflight) | ✅ | A5 fix + prior live (both mentions acknowledged, none dropped) + test |
| C04 | Claude delivery + workspace isolation | ✅ | **PR #10** on branch `vtc-4-c04-…`, commit `[VTC-4] …`, title back-link; **host repo stayed on its branch** (isolation) |
| C05 | Reviewer verdict via @mention | ✅ | A1 single-pipeline fix + test |
| C06 | Reject → rework → re-approve | ✅ | A3 validation-state-machine fix + test |
| C07 | Review re-entry must not launder failing | ✅ | #9 launder-guard fix + regression test |
| C08 | Manual stage-dropdown → Done (honest) | ✅ | VTC-8 → "transitioned to **Done** (no linked pull request)" — no fake merge claim |
| C09 | Goal edit persists + re-engages operator | ✅ | VTC-9 edited goal persisted (X11 + CSRF fix) |
| C10 | Viewer packet-resolve gating | ✅ | X14 fix + prior live (viewer 0 resolve buttons, admin 1) + test |
| C11 | Viewer @operator valve | ✅ | selin @operator on VTC-11 posted (200) but agent-run count unchanged 2→2 |
| C12 | Assign-me hidden from non-members | ✅ | take-ownership: murat (non-member) 0 · selin (member) 1 |
| C13 | Home membership filter | ✅ | selin (viewer) sees only Viberr Core + Selftest 3, not Billing/Deploy |
| C14 | Skills isolation on a real run | ✅ | VTC-4 Claude init: isolated `cwd=…/VTC-4/workspace`, **`mcp: []`** (honest slate flows to runs), declared skills only, no host leak |
| C15 | Meaningful-comment guardrail | ✅ | comment-guardrails enforcement + ON config + tests |
| C16 | Operator brevity guardrail | ✅ | enforcement (markdown-aware truncation, #12) + tests |
| C17 | Waiting-state fallback on chain end | ✅ | #1 fix (always clear waiting=agent) + test |
| C18 | Operator run recommendation = applyable card | ✅ | fixed this session; **browser-verified** (⚡ RUN SPECIALIST card + Apply) + 2 tests |
| C19 | KB nested-doc injection | ✅ | HIGH fix; verified against real data root (seed api-contracts injects 6/6 not 1/6) + 8 tests |
| C20 | Honest credential slate | ✅ | selftest-3 GitHub view: "No credential configured" (no fabricated green card) |
| C21 | PR merge reflection (gh) | ✅ | `gh pr merge 10 --squash` → MERGED (task.md capture shows the documented agent-side reconcile-before-merge behavior) |
| C22 | Cross-backend retry re-resolves model | ✅ | Codex quota error on VTC-4 → Claude path delivered, model re-resolved `sonnet` (A4/X2 fix) |

Coverage vs the brief: project/task/agent creation ✅ · operator agent selection ✅ · 22 (>20) cases ✅ ·
stage transitions (auto/approval/manual) ✅ · reviewers ✅ · comments + @mentions ✅ · RBAC triggering
(valve, packet gate, ownership gate, home filter — across 3 users) ✅ · operator behavior (auto-flow,
vague-packet, coalesce) ✅ · agent delivery both backends + real PR ✅ · MCP (honest empty) ✅ · skill
isolation ✅ · codex/claude parity + retry ✅. Real PR lifecycle: #4/#8/#10 merged, #5/#6/#9 closed.

---

## Phase 3 — Implementation (all findings fixed, validated)

**PR [#7](https://github.com/akin-ozer/viberr/pull/7)** — OPEN, CLEAN, MERGEABLE, CI green. 20 commits.
- The original ~55-finding backlog (`findings-v2.md`) + 8 owner rulings (Q1–Q8).
- 16 adversarial-review defects (3 HIGH) with regression tests.
- 2 CI-hardening fixes (hermetic env; caught-and-logged adapter callbacks).
- The 19 fresh current-state findings: KB injection (HIGH), the seed-fabrication cluster (7 MED, owner
  ruling "honest empty slate"), the operator recommend dead-end (MED), and all 11 LOW honesty/cosmetic.

**Validation**: `npm run typecheck` clean · **full hermetic suite 1130 passing** (verified with `.env`
hidden = true CI parity, real exit code checked) · CI green on every push · live browser + fresh-seed
verification of each changed flow. Nothing deferred; nothing on a chip.

**Deferred by owner decision** (not defects): the deep role-bindings rework (matrix-as-runtime-source,
contributor/viewer split — open ruling Q5) and Codex tool-confinement (S3), both documented for the
dedicated role-bindings phase per the product-intent doc.
