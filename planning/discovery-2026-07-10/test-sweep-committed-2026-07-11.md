# Validation sweep on the COMMITTED build (2026-07-11)

Re-validation after D1–D4 + all runtime fixes landed (commit `a08ff93`). The earlier
`test-sweep-results.md` (22 "Test Harbor" tasks) ran on the PRE-D1–D4 build, so its triage
("recommend → Ready"), Tester-assignment, and accept ("pr=merged") rows are now superseded — see the
"corrections" section at the bottom. This sweep re-runs the changed behaviors + the full dimension
list on the shipped code.

Project **validation-sweep** (VSW, repo cc-devops-skills), members arda=admin, elif=maintainer,
murat=contributor, selin=viewer, deniz=non-member. Both backends real. **22 distinct VSW task records
created** (VSW-1..22) + a Prober profile + the `everything` stdio MCP.

Legend: ✅ pass · ⚠️ finding.

## D2 — triage→ready auto-advance (the biggest behavior change), at scale
The operator auto-advanced **16 well-scoped coding tasks** (VSW-1,2,3,4,5,9,10,12,13,16,17,18,19,20,
21,22) straight from triage → ready → **impl** with the Developer assigned — **zero human approval
clicks**. The vague/ambiguous ones correctly **held at triage** with a scoping packet:
| Task | Goal | Operator judgment |
|---|---|---|
| VSW-6 | "Make the repo better" | ✅ packet: "no actionable acceptance criteria" |
| VSW-7 | export must be CSV **and** JSON (conflict) | ✅ packet: resolve the format conflict first |
| VSW-8 | "Add README badges" | ✅ packet: "need repo/CI/license specifics before scoping" — caught that a build-status badge needs a CI URL |
This is the D2 quality gate working: scoped → auto-advance, underspecified/conflicting → packet.

## D1 — Tester merged into Reviewer (single quality specialist)
- Roster on every VSW deployment is **operator / developer / reviewer** only — no Tester. ✅
- VSW-3 reviewer (Claude, "Review & validation") did BOTH review AND validation in one run: hex-dumped
  the `.github/CODEOWNERS` blob to verify exact content, ran `gh pr diff`/`git diff` to confirm one-file
  scope, and checked PR mergeability — then emitted a clear verdict. ✅ Single quality specialist works.

## D3 — accept never fakes a merge  ✅ (with GitHub cross-check)
- Accepting VSW-3 → stage **done**, `pr.state = "accepted"` (NOT "merged"), completion event reads
  "accepted, merge pending". The agent's **real PR #15 on github.com/akin-ozer/cc-devops-skills is
  still OPEN** — verified via `gh pr view 15` → `OPEN`. The task record never claimed a merge that
  didn't happen (NFR15). A real server merge (with a stored PAT) would still write "merged".

## ⚠️ NEW FINDING (found + fixed this sweep) — reviewer verdict misclassification
VSW-3's first reviewer round recorded "**failing — changes requested**" and bounced the (correct)
work back to the Developer for a wasted loop. Root cause: `classifyReviewerVerdict` checked bare
`\bfail(ed|ing|s)?\b` / `\bblocker\b` as request-changes signals BEFORE approve signals — so a
thorough APPROVE that says "no blockers" / "no tests fail" / "checks don't fail" was misread as a
rejection. **Fixed:** explicit-verdict line wins first ("Verdict: approve/pass" vs "…request/fail"),
then strong reject PHRASES, then `fail`/`blocker` count ONLY when not locally negated (negation-aware
scan incl. the `n't` contraction). Added 2 regression tests; 1021 suite green. (The task still
resolved correctly on its own — the second reviewer approved — but the bug wasted a full dev+review
round and would silently fail-flag many clean approvals.)

## D4 — retry-on-other-backend
- Could NOT be forced live this session: Codex had quota, so no run errored on backend availability
  (0 errored runs across 45 VSW runs). Covered by 3 run-projection unit tests + the pill test:
  `failedBackendUnavailable`+`altBackend` set only when an errored run's log tail matches a
  quota/availability signature; genuine task failures are not flagged; UI renders "Retry on <other>".

## Runtime isolation + agent delivery (re-verified on committed build)
| Dimension | Result |
|---|---|
| Skill isolation (#35) — specialist | ✅ Prober (declared only `conventional-commits`) reports its system prompt has **only** `conventional-commits`, fully rendered; **none** of deep-research/dataviz/blog visible anywhere |
| Skill isolation (#35) — operator | ✅ operator context = **only** `viberr-app-expertise` (skill) + `architecture-notes` (KB); no host skills |
| Delivery reconciliation (#31) | ✅ VSW-3 captured `branch=VSW-3` + real **PR #15**, state **"review"** (canonical vocabulary — the D3 mapping fix, not raw "open"); VSW-2 captured `branch=VSW-2` |

## RBAC & permissions
| # | Case | Result |
|---|---|---|
| viewer create | selin create-task | ✅ 403, no task dir |
| contributor create | murat create-task | ✅ 200 → VSW-13 (SECURITY.md) |
| non-member comment | deniz comment on VSW-1 | ✅ 200, timeline entry `guest: True` (labeled) |
| approval boundary | murat (contributor) impl→review VSW-3 | ✅ 403 |
| approval boundary | arda (admin) impl→review VSW-3 | ✅ 200 |
| rescan gating | murat 403 / elif 200 | ✅ |

## Ownership (user assignments) + mentions
| # | Case | Result |
|---|---|---|
| owner-take | elif take VSW-4 (member self-service) | ✅ 200, `task.ownership.taken` |
| admin-release | arda release-any VSW-4 | ✅ 200, `task.ownership.admin_released` |
| @human mention | @Elif Demir on VSW-4 | ✅ mention notification to elif only |

## File-native tolerance
| # | Case | Result |
|---|---|---|
| VSW-14 | malformed YAML (`stage: [unclosed`) | ✅ readiness floored **blocked**, stage **empty** (NOT phantom "triage") + `frontmatter.unresolved_stage` diagnostic (#27); health stays ok |
| VSW-15 | dir VSW-15 vs frontmatter key VSW-999 | ✅ dir wins, `frontmatter.key_mismatch` diagnostic, readiness `inconsistency_risk_detected` |
| members | project.md member edit (direct file) | ✅ watcher reprojected 4 members in ~1.5s |

## Coverage vs the user's enumerated dimensions (on the committed build)
user assignments ✅ · stage transitions (auto triage→ready→impl, approval impl→review, human
review→done) ✅ · reviewers (D1 merged quality specialist) ✅ · secondary/reviewer assignment ✅ ·
comment usage (non-member guest label, @human mention) ✅ · RBAC triggering ✅ · operator behaving
correctly (auto-advance scoped, packet for vague/conflict/underspecified) ✅ · agents doing their job
(dev branches+PRs, reviewer verdict) ✅ · skills correctly loaded, not unrelated (#35) ✅ · MCP wiring
(prober granted `everything`) ✅ · codex/claude parity (both produce real runs, correct backend rows,
delivery captured) ✅ · D4 unit-verified (quota not reproducible live).

## Corrections to `test-sweep-results.md` (pre-D1–D4 rows now superseded)
- **TH-4** "operator assigned **Tester**" — the Tester profile no longer exists (D1). A validation
  goal now routes to the Developer at impl and the Reviewer validates at review.
- **TH-2/TH-4/TH-5** "recommend → Ready" — triage→ready is now `auto` (D2); the operator advances
  scoped tasks itself rather than filing a recommendation card.
- **TH-2-done** "pr=merged" on human accept — accept now records **"accepted"** (merge pending) when
  no real server merge runs (D3); only a genuine merge writes "merged".
