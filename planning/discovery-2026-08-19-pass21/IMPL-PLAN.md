# Pass 21 — implementation plan (draft v1, finalize after phase-2 wrap)

Method (proven pass-20): file-ownership CLUSTERS run in parallel within a BAND; bands run sequentially; gate `npx tsc` + full `npx vitest run` between bands; every fix canaried (revert→red→restore) where a test pins it. Worktree: this branch (claude/viberr-app-inspection-1fe423). All subagents get: FINDINGS.md row(s) + reference/*.md + RULINGS-DIGEST.md. Rulings are LAW; new rulings R21-1..R21-4 + promote R20-9 (U4).

## Band 0 — canon + safety rails (small, unblock everything)
- C0-CANON (owner: docs/architecture/decisions.md, planning/planning-artifacts/architecture.md, FILES.md): append rulings 84=R20-9, 85=R21-1(record), 86=R21-2, 87=R21-3, 88=R21-4; amend architecture.md linter sections (U1); document tools/ + .oxlintrc.json in the tree doc.
- C0-BASELINE (owner: app/server/db/0001_baseline.sql + rebuilder tests): F21-1 widen validation CHECK to include 'bypassed'; add REAL-write projection test for acceptance:"forced"; verify rebuild path.

## Band 1 — GitHub truth cluster (hot files: pr-linker, branch-sync, github-client, pr-open, github-reconciler, mapping/task.server, github-pills)
- C1-GH (single owning cluster, these files interlock): F21-7 (check-runs tolerance + unknown-checks state + mapPrChecks guard + drifted-payload tests), F21-8 (commit-list per-entry catch + dropped-count), F21-9 (github-client never-throws restored; Reconcile action try/catch; pr-open post-create ZodError path), F21-11 (pat-validator per-field catches), F21-22 (commits count both push paths), OBS-11 (delete empty branch at no-changes acceptance — task-actions edge, coordinate with C2).

## Band 2 — server governance cluster (hot file: task-actions.server.ts — ONE owner)
- C2-ACTIONS: U3 (stage/accept re-check inside file lock), F21-2 (server-side acceptance-disclosure invariant — design first: minimal = server requires explicit `disclosed` ack payload w/ merge-state+revision+verdict echo; UI already sends it via ceremony), F21-6 (reviewer/supporting copy branch on verdictCapable), UC-11 follow-through (force-accept writes + F21-1 interplay), U11 (attach-evidence Claude asymmetry — actually specialist-run; coordinate w/ C3 if file overlaps).

## Band 3 — operator cluster (hot files: operator-run.server.ts, operator-actions.server.ts, triage prompts, specialist-run.server.ts)
- C3-OPERATOR: F21-21 (anchor repo reads to origin/main: keep workspace checkout untouched; give operator `git -C workspace/viberr show origin/main:<path>` guidance + a true read-only main view or explicit prompt warning; prefer mechanical fix: operator toolkit Read root pinned to a `main-view` worktree/dir), F21-16 (label policy scope in get_task payload + manual), F21-14 (manual states acceptance exception), F21-17 (fold drift fact into pr-closed packet), R21-2 (capability-gap packets point at Agent resources), F21-3 (operator MCP pre-flight + single denylist const + pinning test), R20-9 promotion side (delegated-ask disclosure: at minimum manual + typed-event; server check if cheap).
- C3b-RUNTIME (specialist-run/claude-runtime/codex-runtime if disjoint from C3 files): R21-4a phase visibility (wire onPhase: cloning/preparing/running → live-run rows + timeline), F21-13 server-side (reject foreign model id per backend; surface substitution), U11 here if it lives in specialist-run.

## Band 4 — workspace/clone infra
- C4-CLONE (owner: workspace-clone code + push-workspace): R21-4b per-project mirror cache (`--reference`/mirror fetch under /data/projects/<slug>/.gitcache or similar), clone phase events (with C3b), OBS-13 (acceptance branch re-check: warn when branch predates task / name collision).

## Band 5 — UI cluster
- C5-UI (owners: settings-page, agents-page dialogs, app.css, board css, login, notifications): F21-5 (viewer credential gate + test fix), F21-13 UI (disable Save during model reload), F21-18 (key nowrap), U7 (DOM order fix), OBS-7 (fork scope label), OBS-4/OBS-12 copy nuance, F21-23 (ceremony copy for already-merged PR), OBS-6 (SSE 401 backoff), U12 (specialist strings), U5/G4 (New-task placeholder honesty — pending design decision w/ owner or implement gate), U8 (cookie downgrade warn).

## Band 6 — lint adoption (R21-3) — LAST (touches many files)
- C6-LINT: fix the 26 remaining oxlint findings; add `npm run lint` to .github/workflows/ci.yml as required; canon note; keep anti-slop rules; ensure no behavior drift (each fix reviewed against F21-7-style regressions).

## Band 7 — validation
- Full suite ×2 clean + tsc; rebuild container from worktree (`docker compose -p viberr up -d --build`, copy main .env); live re-verify: F21-1 (force-accept + rescan), F21-7 (inject drifted payload? unit-level), F21-21 (VIB repeat of the VIB-7 shape), R21-4 (clone cache timing + phase rows), F21-5 (Selin), ceremony copy; screenshot sweep both themes; update VALIDATION.md.

Held/skipped this pass: UC-9 live-forcing (delegated-ask covered by C3 disclosure work); U6 (docs-only honesty fix in C0-CANON); R20-5 held PRD features stay held (D7/D10/D11/D12).
