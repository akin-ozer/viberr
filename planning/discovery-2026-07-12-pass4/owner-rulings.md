# Owner rulings — pass 4 (2026-07-12)

Asked at the discovery→testing boundary with full background; all four answered.

## R-2026-07-12-5 · Role bindings: STRICT SINGLE-SOURCE **+ BETTER-AUTH CUTOVER**
Every guard consults `ACTION_ROLES` (fix the hardcoded sites: reconcile-github,
grant-github-scope on project.github.tsx; manage-members enforced as its own action in
setMemberRole; interruptRun + run-operator route through run-agents). AND: finish the
Option B migration — the better-auth organization plugin (`organization`/`member` tables)
becomes the org-role source; `users.role` becomes derived from it. Breaking change allowed
(no migrations/backcompat required per pass-4 charter).

## R-2026-07-12-6 · Operator vs boundaries: CURRENT BEHAVIOR INTENDED
`stage-transitions: direct` (incl. full-autonomy promotion) means the org trusted the
operator with transitions; approval/human boundary settings govern HUMANS only (Review→Done
stays structurally locked). Fix is honest copy: Policy page must say so instead of implying
an unconditional human gate (also disclose the Q1 completion-for-acceptance exception —
XS-2's copy fix folds in here).

## R-2026-07-12-7 · Capability catalog: PRUNE THE FAKE TOGGLES
Remove the never-consulted reviewer-verdict ids (approve-review, request-changes,
report-validation-verdict) and other never-consulted advisory ids from the TOGGLEABLE
catalog so the UI cannot promise what nothing enforces. (Keeps genuinely-enforced +
structural ids; display honesty over new enforcement.)

## R-2026-07-12-8 · MCP credentials: WIRE REAL INJECTION
Resolve `secret://` cred refs from the encrypted secret store at run-spawn time and inject
into HTTP headers / stdio env for Claude specialist runs. Completes the MCP story.
