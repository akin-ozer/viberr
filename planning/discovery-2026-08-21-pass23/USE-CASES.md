# Pass 23 — use cases & test cases

Focus: live-validate merged F1–F4 on real merged-main container + fresh bug hunt.
Every UC is exercised **live** on project **Viberr → akin-ozer/viberr** unless noted.
PRs are opened on `akin-ozer/viberr` only; small non-bloating files; some merged,
some rejected, to exercise both paths in the app.

## A. Merged-feature validation (pass-22 F1–F4)
- **UC-01 (F1)** Fresh-data-root boot self-heal: container boots healthy on a
  brand-new `projection.sqlite` (baseline applied, integrity check ok, no crash).
- **UC-02 (F2)** Seed Developer → Claude: the seeded Developer profile is a Claude
  profile (not Codex) out of the box.
- **UC-03 (F3)** Model-availability signal: `/resources/health` computes claude &
  codex availability; a run surfaces the model-availability run-control signal
  (and blocks / warns if a backend is unavailable).
- **UC-04 (F4a)** `github_read` happy path: a Claude Developer with read-github-api
  granted calls `github_read` and receives real repo/PR JSON; audit row
  `task.agent.github_read` records the normalized path + ok; token never leaves server.
- **UC-05 (F4b)** `github_read` scope enforcement (live probe): a path aimed outside
  `/repos/akin-ozer/viberr` (e.g. `/user`, another repo, `..`/`%2e` traversal) is
  rejected; no request leaves the repo; scope_violations / `[unavailable]` result.
- **UC-06 (F4c)** `github_read` is Claude-only: a Codex-backed profile does NOT get
  the tool mounted (advisory), and no credential leaks into codex argv/config.

## B. Delivery flow (operator → developer → review → merge/reject)
- **UC-07** Operator triage: a well-scoped task advances Triage→Ready; a vague task
  is flagged (readiness) instead of advanced.
- **UC-08** Operator assigns the delivering agent (Developer) per profile eligibility.
- **UC-09** Developer implements on the task-key branch, commits, and Viberr opens
  the review PR on the Review transition (server-owned delivery).
- **UC-10** Reviewer specialist authors/runs validation and returns a verdict
  (approve / request-changes) with evidence kept out of the timeline.
- **UC-11** Human accepts completion Review→Done → PR merged (one real merge).
- **UC-12** Human rejects / requests changes at the review gate (one real rejection),
  and the app reflects the rejected/again-in-progress state.
- **UC-13** Reject a PR by merging via `gh` out-of-band vs in-app, and reconcile
  GitHub state (divergence surfacing).

## C. RBAC & access
- **UC-14** Members-only project privacy: a non-member sees the project as if it does
  not exist (404-as-absence), comments included.
- **UC-15** Role gates: Contributor can create/own tasks & accept own task; Viewer is
  read+comment only; Maintainer manages members/profiles/policy; Admin releases owners.
- **UC-16** Owner-scoped authority: a contributor who owns a task may accept its
  completion and resolve non-acceptance packet options, though the column reserves
  those for maintainers.
- **UC-17** Force-accept past the review gate is admin/maintainer only and audited.

## D. Resources: KB / MCP / skills
- **UC-18** Create a knowledge base (folder of docs) and grant it to a profile; the
  agent reads it live; renaming/regranting behaves (no silent orphan).
- **UC-19** Add an MCP server, grant it to a profile; the agent can call its tools;
  Claude (hyphen tools) vs Codex (underscore/stdio) parity.
- **UC-20** Skills load selectively: the developer loads developer-expertise, not the
  reviewer/unrelated skills; the operator loads viberr-app-expertise only.

## E. Interaction & coherence
- **UC-21** Comments & @mentions: @tagging an agent/operator routes and notifies; a
  human @tagged by an agent is notified.
- **UC-22** Secondary (supporting) assignment: operator engages a reviewer alongside
  the developer; supporting vs delivering roles are distinct.
- **UC-23** Stage transition approvals: human-approval boundaries hold for people; a
  direct-capability operator crosses auto-advance boundaries itself.
- **UC-24** Diagnostics / recovery: Re-scan (reconcile board with files) and Recovery
  (reproject store) behave and report honestly.
- **UC-25** UI/UX coherence sweep: page-by-page — no dead controls, honest empty
  states, consistent copy (no em/en dashes in rendered copy), accessible toggles.

## Bug-hunt emphasis
Adversarial angles to probe while running the above:
- github_read scope-bypass payloads (encoded traversal, backslash, prefix-confusion,
  @-authority) — confirm the merged live path matches the unit-tested boundary.
- model-availability edge: what the UI does if a backend flips unavailable mid-run.
- operator honesty: does it ever claim work it did not do; packet framing accuracy.
- delivery divergence: force-push / out-of-band merge / closed-PR reuse.
- empty/first-run states across every page on a clean slate.
