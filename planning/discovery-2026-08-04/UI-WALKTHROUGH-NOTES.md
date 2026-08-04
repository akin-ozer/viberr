# UI walkthrough notes — 2026-08-04 (pass 16)

Live walkthrough of the running app (clean-sheet DB, dev server on :5173, arda@viberr.dev admin).
Findings are tagged: [BUG] defect, [UX] friction/incoherence, [COPY] wording, [Q] owner question, [OK] verified good.

## State at start

Clean-sheet: 0 projects, 1 user (Arda, admin, Local), 0 GitHub connections, 0 KBs, 0 MCP servers,
3 seeded skills (developer-expertise, reviewer-expertise, viberr-app-expertise),
2 global agent profiles (Developer=Codex Ready/In-Progress, Reviewer=Claude Code In-Progress/Review), + operator. Both "not deployed".

## Login page

- [OK] Clean two-panel layout, product pitch left, form right. GitHub/Google buttons show "not configured" with honest explainer.
- [OK] Whitelist-based access copy is clear.

## Home (projects) page

- [OK] Empty state explains the project concept (one board, one repo, one policy) with 1-2-3 steps.
- [UX] Footer of the home page exposes "Re-scan" and "Drop every projection row and re-project the whole store from files" — ops/danger actions sitting on the primary landing surface with no explanation, confirmation copy unknown yet. Feels like a dev drawer leaking into product chrome. → candidate: move behind an admin "maintenance" area or at least style as danger + confirm.
- Grid/List toggle present with only empty state — fine.

## Instance settings (/org/settings)

- Three tabs: GitHub connections / Users & access / Agent resources, with count badges. Back-link "Projects".
- [OK] Connections: explains PAT + minimum-scope validation. Add via POST intent=connection-add works; masked PAT display "····s2VN", scopes chips (repo, pull_request:write), repo count, expires —, default badge, Update token affordance.
- [COPY] Users tab: "1 instance accounts" — count/plural mismatch ("1 instance accounts —").
- [OK] Users: Local badge distinguishes local vs OAuth accounts; Admin/Member segmented control; self-demotion guarded server-side ("You can't demote yourself").
- Agent resources: 4 panels (Knowledge bases, MCP servers, Skills, Global agent profiles). Skills show store:// paths, "updated never", template count. Profiles show runtime + stage chips + "not deployed".
- [Q] Profiles say "not deployed" — meaning of deployment vs project policy attachment needs to surface better? (check semantics in code docs)

## GitHub connection setup (scripted via app API)

- better-auth email sign-in + csrf-from-root-loader + intent=connection-add worked first try; scope validation live-checked against GitHub. [OK]

## New project flow

- [OK] Dialog: name → auto-derived task key (VIB) and auto-derived repo name; connection preselected; workflow preset chip (Standard · 5 stages); 3 policy presets (Strict human-gate / Balanced · recommended / Autonomous within policy) with live explainer text under selection; footer shows the exact FS path it will create + inline validation hint. Toast on create: "VIB initialized — task store created at …".
- [UX-minor] Repo-name auto-derive: typing into the repo field after the name already filled it appends (got "viberrviberr"); auto-derive should stop once user edits or select-on-focus.

## Project workspace (empty states)

- Sidebar: project card (repo · member count), Board/Review queue (count badges), Agents, Policy, GitHub, Activity, Settings.
- Board: 5 stage columns w/ counts, per-stage "+", filter chips (All tasks / Waiting on me / Agent working / Needs attention), free-text filter, Board/List toggle, Re-scan, New task. Empty copy "No tasks yet — create one to start the flow". [OK]
- Review queue: split "Waiting on your acceptance" / "Still in review"; explains accept=merge+Done, human-only. [OK]
- Agents page: stat tiles (profiles approved / live operator / specialists working / threads waiting on human); Orchestration (Operator) vs Specialist profiles (Developer, Reviewer); rich profile detail (eligible stages w/ strikethrough, 3-tier capability policy, context resources, backend order, model, continuity, engagements). Tabs: Profiles / Live / Capability matrix / Add from library.
  - [OK] Capability matrix dialog is outstanding: server-owned delivery, CLAUDE-ENFORCED chips, "advisory on Codex" honesty, full per-profile matrix, "What differs between the two runtimes" section (mid-run comments have no Codex channel; ask-human pauses Claude only; MCP creds Claude-only; Codex renames MCP tool ids hyphen→underscore; MCP tools ungated by matrix — system-prompt rule instead).
  - [BUG?] Both seeded specialist profiles say "Global base · customized for Viberr Core" — but this project is named "Viberr". Where does "Viberr Core" come from? (seed copy? stale project-name interpolation?) → check gagents seed.
  - [Q] Reviewer (Claude Code backend) shows "Advisory only · 6 lines the runtime does not read" — but matrix says limits BIND on Claude. Which lines are advisory on a Claude profile and why? Check the advisory-count logic.
  - [Q] Developer "EXECUTION BACKEND · a run uses the first: Codex, Claude Code" + MODEL "GPT-5.6 Sol"; Reviewer fixed "Claude Code"/"Claude Sonnet". Model names are display-only? Where configured?
- Policy page: RBAC matrix (Admin/Maintainer/Contributor/Viewer × ~18 actions) with app-wide view/comment rows; owner-acceptance nuance; org-admin override note; agent capability counts per profile; ALWAYS RESERVED FOR HUMANS list (merge PR / transition Done except full-autonomy operator w/ explicit grant / change policy); Workflow rules per transition (actor + Auto-advance/Human approval/Human only), Review→Done "locked · V1". [OK — dense but coherent]
  - [UX-minor] The explanatory prose block under the RBAC table is a wall of text; candidate for structuring.
- GitHub page: repo, connection health (masked PAT, proven scopes), PR list (0), execution branches table, "Not yet synced / Update status". [OK]
- Activity: Stream (All/Humans/Agents/System filter) + separate Audit logs (policy & access). Audit captured connection-add/scope-recheck/project-create. [OK]
  - [COPY-minor] audit stamps "today 0:18" — 24h w/o leading zero reads oddly.
- Settings: name/prefix/description, task-key format + canonical task file path, workflow stages editor (drag reorder, click rename, re-wiring copy), members+invite (default Viewer), repo & credentials (Repair…, after-merge delete-branch toggle), danger zone (archive vs delete). [OK]

## State after setup

- Project "Viberr" (VIB) bound to akin-ozer/viberr, Standard 5 stages, Balanced policy, 1 member.
