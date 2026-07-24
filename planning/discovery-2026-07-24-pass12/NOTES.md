# Pass 12 — running discovery notes (2026-07-24)

Branch base: `main` @ 0981cfa (clean-sheet seed merged: PR #90). Dev server on
`docker-data/` via launch.json `viberr-dev` (autoPort → :49720 this run; 5173 was
held by the `viberr-app-1` Docker container, which I `docker compose stop`ped to
avoid two instances on one data root). Login: `arda@viberr.dev` / `viberr-dev-2828`
(`.env` overrides the product default `admin@viberr.dev`).

## Empty-state walkthrough (clean instance, screenshots in shots/)

The clean-sheet seed is honest — a fresh instance has NO demo board data:

- **Home `/` (01):** "Good afternoon, Arda", "No projects yet". Grid/List toggle,
  New project CTA, 3-step onboarding hint (Connect a repo / Define stages / Put agents
  under policy). Settings strip: **1 GitHub connection (akin-ozer)**, **1 user (1 admin ·
  0 members)**, **2 agent profiles + operator · 0 KB · 0 MCP · 3 skills**. Footer:
  Re-scan + Rebuild projections (admin-only).
- **Settings `/org/settings`** (instance-level, three tabs):
  - `?tab=connections` (02): akin-ozer PAT, 3 repos, scopes repo/workflow/pull_request:write,
    "default" badge, Update token / remove. Add connection.
  - `?tab=users` (03): Arda (you), Local, Admin/Member toggle, edit/×. "Allow access"
    (whitelist-based, no invite emails). Board permissions are per-project.
  - `?tab=resources` (04): **Knowledge bases** (empty, +New), **MCP servers** (empty, +Add),
    **Skills** (3: developer-expertise, reviewer-expertise, viberr-app-expertise; each
    `store://skills/<id>/ · 1 file · updated never · N profiles`), **Global agent profiles**
    (Developer, Reviewer + operator; +New).
- **Profile `/profile` (05):** display name/title/email (local, admins edit), Member of,
  Your access ("No project membership yet"), Notification routing toggles (Decision packets,
  Approval requests, Mentions & replies, Policy events, + more below fold), GitHub identity
  ("not connected", Personal OAuth read:user/user:email with ⚠, Connect button).
- **Notifications `/notifications` (06):** "Waiting on you" (0 decisions) + "Everything else"
  (caught up). All/Unread filter.

## New-project modal (07 open button, 08 filled spec)

Fields: **Project name*** (ph "e.g. Payments Gateway"), **Task key** (ph "PAY"),
**GitHub connection*** (akin-ozer/ chip → repository root), **GitHub repository***
(akin-ozer/ + repo-name, project default, task-level override later),
**Workflow template**: Standard·5 stages / Lightweight·3 stages,
**Agent policy preset**: Strict human-gate / Balanced·recommended (default) / Autonomous within policy.
Note text: "Completion stays human-authorized — except an **Autonomous within policy** operator
granted **direct completion authority, which may accept work itself** (disclosed on the Policy page)."
Footer shows target path `docker-data/projects/…/`. → TEST: autonomous preset self-accept path.

## create-project action (app/routes/_index.tsx:110)

`intent=create-project`: name, key, owner (repo owner), repoName, template
(governed|light), policy (strict|balanced|auto). **RBAC: self-serve for ANY signed-in
member — no org-admin gate** (deliberate, pinned by test); creator becomes project admin.

## Capability model (app/shared/capabilities.ts) — for live agent-creation tests

UNIFIED_CAP_CATALOG kinds: operator vs agent. Key facts:
- Headline **`execute-code-or-write-repo`** is the MASTER GATE for all delivery — with it
  withheld, scoped grants (create-branch/commit-push/open-PR) are vetoed → silent no-delivery
  (VIB-1 class). `normalizeDeliveryGrants` re-enables headline if any scoped grant is actionable.
- `report-validation-verdict` default OFF (acceptance-veto power; seed grants only reviewer);
  `ask-human` default granted. Both enforce on BOTH backends.
- ALWAYS_HUMAN: merge-pull-request, transition-to-done, change-project-policy.
- CLAUDE_ONLY enforced (advisory on Codex): create-branch, commit-push, open-PR,
  execute-code-or-write-repo, comment-on-task (Codex has no in-process comment/denylist channel).
- `completion-for-acceptance` never autonomy-promoted to direct EXCEPT the autonomous operator.

## Seed agent catalog (app/server/seed/agent-catalog.server.ts)

3 base profiles preinstalled on every board (BASE_AGENT_PROFILE_IDS):
- **Operator** (kind operator, backends claude+codex, spanAll, stages triage→done): direct
  assign/summon/packets/events; recommend transitions+completion; forbidden execute/done/policy.
  Resources: skill viberr-app-expertise, mcp `viberr` (in-process governance MCP), kb architecture-notes.
- **Developer** (specialist, backends codex+claude, stages ready/impl, model gpt-5.6-sol): full
  delivery grants incl. headline; forbidden merge/done. Resources: skill developer-expertise, no MCP,
  kb architecture-notes+api-contracts.
- **Reviewer** (specialist, backend claude only, stages impl/review, model sonnet): read/run-validation/
  author-tests/evidence/quality-flags/comment/ask/**report-verdict**; recommend approve/request-changes;
  forbidden merge/done/**commit-push** (real human grant → tool policy denies git push+commit).
  Resources: skill reviewer-expertise, kb api-contracts.

## Open questions to raise with owner (as they firm up)
- (pending — will populate during live phase)

## Findings candidates (main-context observed; verify)
- **N-favicon:** every page load logs `Error: No route matches URL "/favicon.ico"` (server
  console spam). No favicon route/asset. LOW but noisy; confirm no `public/favicon.ico`.
- Better Auth boot WARN: "Base URL is not set" (BETTER_AUTH_URL / baseURL unset) — callbacks/
  redirects may misbehave behind a proxy. Confirm intended for local dev only.
