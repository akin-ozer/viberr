# Live test results v2 (2026-07-11 session 2)

Project **Viberr Selftest** (slug viberr-selftest, repo akin-ozer/viberr) + **Strictline** (strict
preset, repo akin-ozer/strictline). Real Claude + Codex backends (Codex hit its usage quota mid-run,
which itself exercised the D4 retry path). Real PRs on github.com/akin-ozer/viberr: **#4 merged, #5 &
#6 closed** via `gh` — all reflected correctly in viberr.

## Executed cases (25) — evidence + verdict

| # | Case | Verdict | Evidence / finding |
|---|---|---|---|
| T0 | Create project (balanced) | ✅ + bugs | Modal heading "New governed project" (G1); empty-repo field fabricated `akin-ozer/viberr-selftest`… actually used explicit "viberr" — but Strictline empty→fabricated (X12). |
| T1 | Operator auto-flow (D2) | ✅ | Real Claude operator advanced triage→ready→impl, assigned Developer, posted 1 entry/turn. Found X1,X3,X4,X6,X7. |
| T2 | Vague task → packet | ✅ PASS | VST-2 "Improve the app" → operator opened an INPUT packet with 3 scoped options, did NOT advance. |
| T3 | Concurrency double-trigger | ⚠️ | VST-4 @operator mention during inflight operator run was DROPPED (A5) — coalesced and never answered. |
| T4 | Claude delivery | ✅ + X1 | VST-1 → branch VST-1, commit `7103fe8` `VST-1:`-prefixed, PR #4 w/ back-link. Agent worked in HOST checkout (X1). |
| T5 | Codex delivery | ✅ + X1 | VST-4 → branch VST-4, commit `48ebc8a` `[VST-4]`-prefixed, PR #6. Codex ALSO left host repo on branch (X1 both backends). |
| T6 | Merge PR externally | ✅ PASS | `gh pr merge 4 --squash` → merged; local main fast-forwarded, T1.md present. |
| T7 | Close PRs externally | ✅ PASS | `gh pr close 5, 6` → CLOSED on GitHub. |
| T8 | Accepted merge-pending | ~ | VST-4 accepted to Done with pr:null (no server PR opened — X7); completion copy claimed "PR merged" (X13). |
| T10 | Reviewer via operator | ✅ PASS | VST-1 reviewer run → validation healthy, quality event "Review passed", owner notification. |
| T11 | Reviewer via UI Run button | ✅ PASS (H2) | VST-3 defective branch → reviewer request_changes → validation **failing** + quality event + notification. |
| T12 | Reviewer via @mention | 🐛 A1 | VST-3 @reviewer run replied but validation stayed `none`, ZERO quality events — verdict+reconcile hook clobbered. |
| T13 | Reject→rework→re-approve | 🐛 A3 | Defect reverted; reviewer re-APPROVED (quality event) but validation STAYED failing; operator opened a packet admitting it "cannot resolve which signal is authoritative" and refused the transition. State machine paralyzed. Also X9 (verdict on truncated text). |
| T18 | Strict preset (S1) | ✅ PASS | Strictline pre-work boundaries = `approval`; well-scoped STR-1 → operator RECOMMENDED move-to-Ready, did NOT auto-advance. |
| T14b | Recommendation apply chain | ✅ PASS | VST-1: applied transition rec → review; applied accept rec → Done, validation healthy, completion event. |
| T20 | Board drag → Done | 🐛 C4 | VST-4 stage-dropdown → Done ran full acceptance (merge attempt + completion event) with no confirm; copy "review PR was merged" on a PR-less task (X13). |
| T15/17 | Viewer resolves packet | 🐛 X14 | selin (viewer) saw ALL 3 packet resolve options + Assign-me; click server-rejected (state unchanged) but SILENT (no error). M2/M3 confirmed. |
| T16 | Viewer @mention valve | ✅ PASS | selin @operator comment posted (app-wide) but triggered NO run (seam-1 valve held). |
| T21 | Skills isolation | ✅ PASS | VST-1 dev run system-init: "29 tools · mcp: github-mcp" only — no host `~/.claude` skill leak; declared skills injected as persona text. |
| T22 | MCP injection | 🐛 X3 | Fictional seeded `github-mcp` (mcp.internal:7801) injected into every real Claude run; SDK tolerated the dead endpoint (run still succeeded). |
| D4 | Retry on other backend | 🐛 A4/X2 | Codex quota error → "Retry on Claude Code" button worked (run succeeded) BUT run row recorded model `gpt-5.5` while system-init showed `claude-sonnet-5` — dishonest metadata; native-model would hard-fail on a real cross-backend model id. |
| — | Home visibility as viewer | 🐛 D10 | selin saw all 5 projects (member of 1) + New-project button — home not membership-filtered. |
| — | Logout | ✅ PASS | Sign-out clears session, returns to login (D11 retracted — earlier "broken" was a mis-click). |
| — | OAuth buttons | ❓ D12 | GitHub/Google login buttons render enabled with no provider configured — verify. |
| — | PR states reflected | ✅ PASS | GitHub page + PR pills reflect merged/closed after `gh` actions + reconcile. |

## Coverage vs the brief
User assignments ✅ · stage transitions ✅ (auto/approval/human all exercised) · reviewers ✅ (operator/button/mention) · secondary/reviewer assignment ✅ · comments+mentions ✅ · RBAC triggering ✅ (viewer valve, packet-resolve deny, home visibility) · operator behavior ✅ (packets, recommend vs direct, react loop, paralysis) · agent work quality ✅ (both backends, real PRs) · MCP ✅ (X3) · skill loading correctness ✅ (T21, no unrelated skills) · codex vs claude parity ✅ (delivery parity + X1/X2/F1/F2 divergences) · presets ✅ (S1 strict verified live).

## New findings surfaced live (in findings-v2.md §X): X1–X15, and confirmed A1, A3, A4, A5, C4, M2, M3, S1.
Bar of ≥20 executed cases met (25 executed). Real-PR lifecycle (open/merge/close) exercised end-to-end.
