# Pass 20 — Session notes (running)

## Environment facts (this machine, 2026-08-14)
- App: production compose image `viberr-app-1` on :5173, data root `/Users/akinozer/projects/viberr/docker-data` (bind → /data).
  **docker-data had been deleted under the running container** → ghost-mount state; recreated + restarted (see F20-1..3).
- `compose.override.yml` (UNTRACKED, machine-local) added: `dns: [1.1.1.1, 8.8.8.8]` for the app service —
  Docker Desktop embedded DNS returned AAAA-only for api.anthropic.com (no IPv6 route → every Claude run ENOTFOUND).
  Upstream DNS still blips occasionally (github.com transiently unresolvable once — operator packet handled it).
- Container has chromium 151 + uvx + codex CLI; claude via agent SDK. Codex auth OK (auto-seeded auth.json).
  **This Codex account supports gpt-5.6-terra (CLI default), NOT gpt-5.6-sol** (400 invalid_request_error) → F20-4.
- Login arda@viberr.dev / (e2e cred). gh CLI logged in as akin-ozer (repo scope PAT via keyring).
- GitHub connection created in-app with `gh auth token` piped through env — token never displayed.
- Playwright driver daemon (port 7788) drives the real UI; `scratchpad/drv.py` is the CLI. Screenshot rig `shot.js`.
- Browser pane of the host session is wedged/hidden — all UI work goes through the driver (real input events).

## Instance state built so far
- Org: 1 GitHub connection (akin-ozer, default). SSO unconfigured (rows honest). Users: arda only.
- Resources: KB `viberr-test-conventions` (1 doc, canary BLUE-HERON-42, live-folder watch verified);
  MCP `everything` (16 tools, up after manual retest → N20-2), MCP `web-fetch` (uvx, background-install path verified);
  skills `pr-etiquette` (canary AMBER-FALCON-7), `kubernetes-tuning` (decoy CRIMSON-YAK-99) + 3 seeded.
- Project **Viberr** (`akin-ozer/viberr`, VIB, Standard 5 stages, Balanced preset).
  Profiles: Operator (claude sonnet, supervised), Developer (codex **gpt-5.6-terra**, high; browser+egress ON;
  skills: developer-expertise + both canaries; MCPs: everything + web-fetch; KB granted),
  Reviewer (claude sonnet, seeded), UX Verifier (claude opus MAX, browser+egress+evidence ON, KB granted; created in-project).
- VIB-1 delivered end-to-end: PR #160 MERGED, task Done. Full loop referenced in USE-CASES.md UC-01.

## Key observations (beyond FINDINGS.md)
- Operator quality: verifies before acting (checked file absent before Triage→Ready), one-boundary-per-turn rule,
  precise packets with git's own words (R19-13 live), recommend-mode respected (accept_completion → recommendation).
- Reviewer quality: revision-pinned verification (rev-parse vs pinned revision), byte-level `od -c` check, Skill tool used.
- AcceptConfirm ceremony rendered: APPLYING / MERGES PR#160 / REVISION / VERDICT / "Merging is one-way".
- Run console: thought folds, tool chips, run-inputs disclosure line ("3 skills · 1 KB · 3 MCP servers · 1 grant did
  NOT reach this run") — expand and verify which grant didn't reach (likely browser: egress was off at engage time?).
  → follow up in UC-06/08.
- Board chip "agent working" appears on Triage cards while operator runs — good live signal.
- Task page "Run operator" allowed while a packet is open → paid no-op (F20-5).

## Handoff notes for subagents
- Drive the app: `python3 <scratchpad>/drv.py goto/click/fill/eval/text/shot ...` against 127.0.0.1:7788.
- Container inspection: `docker exec viberr-app-1 sh -c '...'` (no python3 inside; node is available).
- Run logs: /data/runtimes/{claude,codex}/run_*.jsonl; canonical task file /data/projects/viberr/tasks/<KEY>/task.md.
- Reference docs: planning/discovery-2026-08-14-pass20/reference/*.md (verified at b97ad02).
- Ground rules: PRs only on akin-ozer/viberr with tiny test-artifacts/* files; never bloat accepted changes.
